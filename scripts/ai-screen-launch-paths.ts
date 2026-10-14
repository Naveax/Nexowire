import * as ts from 'typescript';
import {promises as fs} from 'node:fs';
import path from 'node:path';

export const NATIVE_LAUNCH_FUNCTIONS=[
  'spawn','spawnSync','exec','execSync','execFile','execFileSync','fork',
] as const;
export type NativeLaunchFunction=typeof NATIVE_LAUNCH_FUNCTIONS[number];

export interface NativeLaunchSink{
  file:string;
  functionName:NativeLaunchFunction;
  line:number;
  signature:string;
}

const known=new Set<string>(NATIVE_LAUNCH_FUNCTIONS);
const isChildProcess=(value:string)=>
  value==='node:child_process'||value==='child_process';
const normalized=(value:string)=>value.replace(/\\/g,'/');

function calledRequire(moduleName:ts.Expression):boolean{
  return ts.isCallExpression(moduleName)&&
    ts.isIdentifier(moduleName.expression)&&
    moduleName.expression.text==='require'&&
    moduleName.arguments.length===1&&
    !!moduleName.arguments[0]&&
    ts.isStringLiteral(moduleName.arguments[0])&&
    isChildProcess(moduleName.arguments[0].text);
}

/**
 * Audits direct Node child_process callsites using the TypeScript AST.
 * This does not inspect PowerShell generated at runtime, native DLL calls,
 * executable internals, aliases returned by factories or script strings.
 */
export function scanNativeLaunches(file:string,source:string):NativeLaunchSink[]{
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,
    file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  const imports=new Map<string,NativeLaunchFunction>();
  const namespaces=new Set<string>();
  for(const statement of sf.statements){
    if(ts.isImportDeclaration(statement)&&
      ts.isStringLiteral(statement.moduleSpecifier)&&
      isChildProcess(statement.moduleSpecifier.text)){
      const bindings=statement.importClause?.namedBindings;
      if(bindings&&ts.isNamedImports(bindings)){
        for(const element of bindings.elements){
          const original=(element.propertyName??element.name).text;
          if(known.has(original))imports.set(element.name.text,
            original as NativeLaunchFunction);
        }
      }else if(bindings&&ts.isNamespaceImport(bindings)){
        namespaces.add(bindings.name.text);
      }
    }
    if(!ts.isVariableStatement(statement))continue;
    for(const declaration of statement.declarationList.declarations){
      if(!declaration.initializer||!calledRequire(declaration.initializer))continue;
      if(ts.isIdentifier(declaration.name))namespaces.add(declaration.name.text);
      if(ts.isObjectBindingPattern(declaration.name)){
        for(const element of declaration.name.elements){
          const symbol=element.propertyName&&ts.isIdentifier(element.propertyName)
            ?element.propertyName.text:ts.isIdentifier(element.name)
              ?element.name.text:'';
          if(symbol&&known.has(symbol)&&ts.isIdentifier(element.name)){
            imports.set(element.name.text,symbol as NativeLaunchFunction);
          }
        }
      }
    }
  }
  const output:NativeLaunchSink[]=[];
  const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)){
      let functionName:NativeLaunchFunction|undefined;
      const callee=node.expression;
      if(ts.isIdentifier(callee)){
        functionName=imports.get(callee.text);
      }else if(ts.isPropertyAccessExpression(callee)){
        if(ts.isIdentifier(callee.expression)&&
          namespaces.has(callee.expression.text)&&known.has(callee.name.text)){
          functionName=callee.name.text as NativeLaunchFunction;
        }
        if(ts.isCallExpression(callee.expression)&&
          calledRequire(callee.expression)&&known.has(callee.name.text)){
          functionName=callee.name.text as NativeLaunchFunction;
        }
      }
      if(functionName){
        const {line}=sf.getLineAndCharacterOfPosition(node.getStart(sf));
        output.push({
          file:normalized(file),functionName,line:line+1,
          signature:normalized(file)+'#'+functionName,
        });
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(sf);
  return output;
}

export async function collectNativeLaunches(
  root:string,relativeRoot='src',
):Promise<NativeLaunchSink[]>{
  const out:NativeLaunchSink[]=[];
  const walk=async(relative:string):Promise<void>=>{
    const absolute=path.join(root,relative);
    const names=(await fs.readdir(absolute,{withFileTypes:true}))
      .sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of names){
      const name=path.join(relative,entry.name);
      if(entry.isDirectory()){
        await walk(name);
      }else if(entry.isFile()&&/\.tsx?$/.test(entry.name)){
        out.push(...scanNativeLaunches(
          normalized(name),await fs.readFile(path.join(root,name),'utf8'),
        ));
      }
    }
  };
  await walk(relativeRoot);
  return out.sort((a,b)=>a.signature.localeCompare(b.signature)||
    a.line-b.line);
}

export function countSignatures(sinks:readonly NativeLaunchSink[]):
  Record<string,number>{
  const count:Record<string,number>=Object.create(null) as Record<string,number>;
  for(const sink of sinks)count[sink.signature]=(count[sink.signature]??0)+1;
  return Object.fromEntries(Object.entries(count)
    .sort(([a],[b])=>a.localeCompare(b)));
}

export interface LaunchAuditDelta{
  unexpected:Array<{signature:string;found:number;approved:number}>;
  removed:Array<{signature:string;found:number;approved:number}>;
}

/** The manifest is a review baseline, NOT a security authorization. */
export function compareLaunchInventory(
  approved:Record<string,number>,
  observed:Record<string,number>,
):LaunchAuditDelta{
  const unexpected:Array<{signature:string;found:number;approved:number}>=[];
  const removed:Array<{signature:string;found:number;approved:number}>=[];
  for(const key of new Set([...Object.keys(approved),...Object.keys(observed)])){
    const expected=approved[key]??0;
    const found=observed[key]??0;
    if(found>expected)unexpected.push({signature:key,found,approved:expected});
    if(found<expected)removed.push({signature:key,found,approved:expected});
  }
  unexpected.sort((a,b)=>a.signature.localeCompare(b.signature));
  removed.sort((a,b)=>a.signature.localeCompare(b.signature));
  return{unexpected,removed};
}
