/** Validate an offline receipt's expected identity before comparing any bytes.
 * This is shape/identity evidence only; never a task, writer or signing authority.
 */
export interface OfflineRecoveryReceiptIdentity {
  readonly version:1;
  readonly host:string;
  readonly marker:string;
  readonly sourceRoot:string;
  readonly launcherPath:string;
  readonly launcherSha256:string;
  readonly port:number;
  readonly originalUserPrincipal:string;
  readonly createdAt:string;
}
const keys=['version','host','marker','sourceRoot','launcherPath','launcherSha256',
  'port','originalUserPrincipal','createdAt'] as const;
function fail():never{throw Error('AI02_OFFLINE_RECOVERY_RECEIPT_IDENTITY_UNVERIFIED')}
function text(value:unknown):value is string{
  return typeof value==='string'&&value.length>0&&value.length<=4096&&
    value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value);
}
/** Snapshot own data fields only. Missing expected fields must never compare
 * equal to missing receipt fields. No claim that the caller's pin is trusted.
 */
export function captureOfflineRecoveryReceiptIdentity(input:unknown):Readonly<OfflineRecoveryReceiptIdentity>{
  if(!input||typeof input!=='object'||Array.isArray(input))fail();
  let values:Record<string,unknown>;
  try{
    const descriptors=Object.getOwnPropertyDescriptors(input);
    if(Reflect.ownKeys(descriptors).length!==keys.length)fail();
    values=Object.create(null) as Record<string,unknown>;
    for(const key of keys){
      const descriptor=Object.getOwnPropertyDescriptor(descriptors,key)?.value as PropertyDescriptor|undefined;
      if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))fail();
      values[key]=descriptor.value;
    }
  }catch{fail()}
  const {version,host,marker,sourceRoot,launcherPath,launcherSha256,port,originalUserPrincipal,createdAt}=values;
  if(version!==1||!text(host)||!text(marker)||!text(sourceRoot)||!text(launcherPath)||
     typeof launcherSha256!=='string'||!/^[a-f0-9]{64}$/.test(launcherSha256)||
     typeof port!=='number'||!Number.isSafeInteger(port)||port<1||port>65535||
     !text(originalUserPrincipal)||!text(createdAt)||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)||
     !Number.isFinite(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)fail();
  return Object.freeze({version,host,marker,sourceRoot,launcherPath,launcherSha256,port,
    originalUserPrincipal,createdAt});
}
