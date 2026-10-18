import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../src/agent/executors.js';
import {PathDeniedError,PathPolicy} from '../src/agent/path-policy.js';

const grantId='11111111-1111-4111-8111-111111111111';
const cmd=(filePath:string)=>({
  grant_id:grantId,path:filePath,
});
const hasCode=(code:string)=>(e:unknown)=>
  !!e&&typeof e==='object'&&'code'in e&&e.code===code;

test('private picker enforces existing regular file under the same native files policy',{
  skip:process.platform!=='win32',
},async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'nx-picker-scope-'));
  try{
    const allowed=path.join(home,'allowed');
    const outside=path.join(home,'outside');
    await fs.mkdir(allowed);await fs.mkdir(outside);
    const insideFile=path.join(allowed,'test.txt');
    const outsideFile=path.join(outside,'secret.txt');
    const shortcut=path.join(allowed,'alias.lnk');
    await fs.writeFile(insideFile,'sandbox test');
    await fs.writeFile(outsideFile,'out of scope');
    await fs.writeFile(shortcut,'fake shortcut fixture');
    const policy=new PathPolicy([allowed]);
    // Existing in-root regular file passes native file policy, reaches
    // binder validation, and rejects nonexistent token before touching GUI.
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(insideFile),policy),hasCode('PICKER_GRANT_INVALID'));
    // An outside-root file is refused before any private edit/invoke attempt.
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(outsideFile),policy),e=>e instanceof PathDeniedError);
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(allowed),policy),hasCode('PICKER_TARGET_NOT_FILE'));
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(path.join(allowed,'missing.txt')),policy),
    e=>!!e&&typeof e==='object'&&'code'in e&&e.code==='ENOENT');
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(shortcut),policy),hasCode('PICKER_PATH_UNSAFE'));
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(insideFile+':secret'),policy),hasCode('PICKER_PATH_UNSAFE'));
    // The path policy's realpath check must catch a symlink/junction into
    // an otherwise inaccessible directory. Windows policy may disallow
    // creating links, so only this subcase is skipped when unavailable.
    const link=path.join(allowed,'outside-link');
    try{
      await fs.symlink(outside,link,'junction');
    }catch{return;}
    await assert.rejects(executeCapability('windows.private_desktop.file_picker.select',
      cmd(path.join(link,'secret.txt')),policy),
      e=>e instanceof PathDeniedError);
  }finally{
    await fs.rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
});
