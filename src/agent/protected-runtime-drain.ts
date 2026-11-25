/** Local quiescence is NECESSARY but never sufficient evidence of OS drain.
 * The external selection authority independently verifies RELEASE. */
export class ProtectedRuntimeDrain {
  private sealed=false;
  private uncertain=false;
  private readonly pending=new Set<Promise<unknown>>();
  seal():void{this.sealed=true;}
  markUnknown():void{this.uncertain=true;}
  async run<T>(effect:()=>Promise<T>):Promise<T>{
    if(this.sealed)throw Error('PROTECTED_RUNTIME_STOPPED');
    // Reserve synchronously, before invoking any caller callback.
    const task=Promise.resolve().then(()=>{
      if(this.sealed)throw Error('PROTECTED_RUNTIME_STOPPED');
      return effect();
    });
    this.pending.add(task);
    try{return await task;}finally{this.pending.delete(task);}
  }
  async wait(timeoutMs=30000):Promise<void>{
    this.seal();
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)
      throw Error('PROTECTED_RUNTIME_DRAIN_TIMEOUT_INVALID');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([
        Promise.allSettled([...this.pending]),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('PROTECTED_RUNTIME_DRAIN_UNKNOWN')),timeoutMs);}),
      ]);
      if(this.pending.size||this.uncertain)throw Error('PROTECTED_RUNTIME_DRAIN_UNKNOWN');
    }finally{if(timer)clearTimeout(timer);}
  }
}
