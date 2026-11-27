#!/usr/bin/env python3
"""Disposable local PG role/exclusion test. No DSN, no TCP, no production use.
Run as non-root on an isolated machine with initdb, pg_ctl, psql on PATH.
Requires all five exact baseline SQL files + reviewed patch.
The role fixture intentionally commits synthetic staged rows without external
witness; this is SQL ACL/concurrency testing, NOT authority/provider acceptance.
"""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, time, uuid, sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE={'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b','sql/helper-selection-authority.sql':'32338077c0cd85789f475b1a76e93ad4a1351863','sql/core-broker-dispatch-credentials.sql':'4cd511f8246025c7293202070527c66710b80a62','sql/core-broker-dispatch-credential-fence.sql':'6c847b5386312a2550318f68792822feb5a93192','sql/large-transfer-authority.sql':'ab495d8c34b10cdd04f88e5ad1b2d40fde8b082d'}
def blob(p):
 b=p.read_bytes();return hashlib.sha1(f'blob {len(b)}\0'.encode()+b).hexdigest()
def uid():return str(uuid.uuid4())
def q(s):return "'"+str(s).replace("'","''")+"'"
def main():
 if os.geteuid()==0:raise SystemExit('NOT_RUN: initdb requires non-root isolated account')
 for b in ('initdb','pg_ctl','psql'):
  if not shutil.which(b):raise SystemExit('NOT_RUN: missing '+b)
 for p,h in BASE.items():
  if blob(ROOT/p)!=h:raise SystemExit('BASE_BLOB_MISMATCH: '+p)
 # Ignore caller PG* settings, user home and connection services.
 env={k:v for k,v in os.environ.items() if not k.startswith('PG')};env['LC_ALL']='C';env['PGCONNECT_TIMEOUT']='5'
 with tempfile.TemporaryDirectory(prefix='nx02-pg-review-') as d:
  p=pathlib.Path(d);sock=p/'sock';sock.mkdir(mode=0o700);data=p/'data';port='55482';started=False;passed=0
  def run(argv,**kw):return subprocess.run(argv,env=env,text=True,capture_output=True,timeout=30,**kw)
  def must(argv):
   x=run(argv);assert x.returncode==0,x.stdout+x.stderr;return x.stdout
  def args(role):return ['psql','-X','-w','-h',str(sock),'-p',port,'-U',role,'-d','postgres','-v','ON_ERROR_STOP=1','-At']
  def sql(role,statement,deny=None):
   x=run(args(role)+['-c',statement]);
   if deny is None:assert x.returncode==0,x.stdout+x.stderr
   else:assert x.returncode!=0 and deny in x.stderr,x.stdout+x.stderr
   return x.stdout.strip()
  def ok(label):
   nonlocal passed;passed+=1;print(f'PASS {label}',flush=True)
  try:
   must(['initdb','-D',str(data),'-U','nx_fixture_admin','--auth=trust','--no-locale']);must(['pg_ctl','-D',str(data),'-l',str(p/'postgres.log'),'-o',f"-c listen_addresses='' -c unix_socket_directories='{sock}' -p {port}",'-w','start']);started=True
   admin='nx_fixture_admin';legacy='nx_fixture_legacy';consume='nx_fixture_consume';recon='nx_fixture_reconcile'
   for base in BASE:must(args(admin)+['-f',str(ROOT/base)])
   sql(admin,"CREATE ROLE nx_lifecycle_sql_owner NOLOGIN; CREATE ROLE nx_lifecycle_consume NOLOGIN; CREATE ROLE nx_lifecycle_reconcile NOLOGIN; CREATE ROLE nx_fixture_legacy LOGIN; CREATE ROLE nx_fixture_consume LOGIN; CREATE ROLE nx_fixture_reconcile LOGIN; GRANT nx_lifecycle_consume TO nx_fixture_consume; GRANT nx_lifecycle_reconcile TO nx_fixture_reconcile; GRANT USAGE ON SCHEMA core_dispatch,helper_selection TO nx_fixture_legacy; GRANT SELECT ON core_dispatch.authorities,core_dispatch.grants,helper_selection.selections,helper_selection.leases TO nx_fixture_legacy; GRANT UPDATE(max_seen_ms) ON core_dispatch.authorities TO nx_fixture_legacy; GRANT INSERT,UPDATE ON helper_selection.leases TO nx_fixture_legacy; GRANT UPDATE(revision,sha256,signer_sha256) ON helper_selection.selections TO nx_fixture_legacy;")
   a,dev,owner,dep,sess,broker,rev,store,other=[uid() for _ in range(9)];a2=uid();repair_a=uid();core_a=uid();core_dev=uid();genesis='0'*64
   sql(admin,f"INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES({q(a)},1),({q(a2)},1),({q(repair_a)},1),({q(core_a)},1); INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES({q(a)},{q(dev)},{q(owner)},{q(dep)},{q(sess)},1,1,{q(broker)},'ACTIVE'); INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision) VALUES({q(a)},{q(dev)},{q(owner)},{q(dep)},{q(sess)},1,1,{q(broker)},{q(rev)});")
   # Seed disposable CORE/transfer history before the review migration.
   # No operator bypass after bootstrap: every raw writer is subsequently fenced.
   sql(admin,"GRANT USAGE ON SCHEMA transfer_authority TO nx_fixture_legacy; GRANT SELECT,INSERT,UPDATE ON transfer_authority.jobs,transfer_authority.claims,transfer_authority.grants,core_dispatch.grants,core_dispatch.claims TO nx_fixture_legacy;")
   cases=[]
   for state in ['ACTIVE','UNKNOWN','SETTLED','SEALED','PENDING_ONLY','APPLIED']:
    ca,source,target,job,claim=[uid() for _ in range(5)];cases.append((state,ca,source,target,job,claim))
    sql(admin,f"INSERT INTO core_dispatch.authorities(authority_id,max_seen_ms) VALUES({q(ca)},1);")
    for device in [source,target]:
     sql(admin,f"INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES({q(ca)},{q(device)},{q(owner)},{q(dep)},{q(sess)},1,1,{q(broker)},'ACTIVE');")
    sql(admin,f"INSERT INTO transfer_authority.grants(authority_id,owner_id,project_id,source_device_id,target_device_id,source_device_epoch,source_session_epoch,source_owner_epoch,source_generation,target_device_epoch,target_session_epoch,target_owner_epoch,target_generation,source_root,target_root,target_public_key_pem,state,expires_ms) VALUES({q(ca)},{q(owner)},'fixture',{q(source)},{q(target)},{q(dep)},{q(sess)},1,1,{q(dep)},{q(sess)},1,1,'fixture-source','fixture-target','fixture-public-key','ACTIVE',1);")
    pending=q(claim) if state=='PENDING_ONLY' else 'NULL';job_state='CANCELLED' if state in ['UNKNOWN','PENDING_ONLY'] else 'ACTIVE'
    sql(admin,f"INSERT INTO transfer_authority.jobs(id,authority_id,owner_id,project_id,source_device_id,target_device_id,target_path_key,binding,epoch,lease_hash,pending_id,state) VALUES({q(job)},{q(ca)},{q(owner)},'fixture',{q(source)},{q(target)},'fixture-target','{{}}'::jsonb,1,{q('a'*64)},{pending},{q(job_state)});")
    if state!='PENDING_ONLY':sql(admin,f"INSERT INTO transfer_authority.claims(request_id,job_id,claim_id,epoch,lease_hash,intent_hash,intent,state) VALUES({q(claim)},{q(job)},{q(uid())},1,{q('a'*64)},{q('b'*64)},'{{}}'::jsonb,{q(state)});")
   sql(admin,f"INSERT INTO core_dispatch.grants(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,state) VALUES({q(core_a)},{q(core_dev)},{q(owner)},{q(dep)},{q(sess)},1,1,{q(broker)},'ACTIVE'); INSERT INTO core_dispatch.claims(request_id,authority_id,device_id,dispatch_id,broker_id,request,sequence,reserved_at_ms,reserve_expires_ms,begin_nonce,state) VALUES({q(uid())},{q(core_a)},{q(core_dev)},{q(uid())},{q(broker)},'{{}}'::jsonb,1,1,2,{q('a'*64)},'RESERVED');")
   # Existing history before migration, to check preservation.
   rid=uid();request=uid();sql(legacy,f"INSERT INTO helper_selection.leases(id,request_id,authority_id,device_id,kind,request_hash,expected_revision,state) VALUES({q(rid)},{q(request)},{q(a)},{q(dev)},'RUNTIME',{q('a'*64)},{q(rev)},'ACTIVE'); UPDATE helper_selection.leases SET state='RELEASED' WHERE id={q(rid)};")
   must(args(admin)+['-f',str(ROOT/'sql/helper-selection-lifecycle-review.sql')]);assert sql(admin,f"SELECT state FROM helper_selection.leases WHERE id={q(rid)}")=='RELEASED';ok('existing history retained')
   def legacy_insert(kind, id=None, device=dev):
    id=id or uid();return f"INSERT INTO helper_selection.leases(id,request_id,authority_id,device_id,kind,request_hash,expected_revision,state) VALUES({q(id)},{q(uid())},{q(a)},{q(device)},{q(kind)},{q('a'*64)},{q(rev)},'ACTIVE')"
   r=uid();sql(legacy,legacy_insert('RUNTIME',r));sql(legacy,f"UPDATE helper_selection.leases SET state='RELEASED' WHERE id={q(r)}");ok('legacy runtime insert/release')
   r=uid();newrev=uid();sql(legacy,legacy_insert('DEPLOYMENT',r));sql(legacy,f"UPDATE helper_selection.leases SET state='COMMITTED',committed_revision={q(newrev)} WHERE id={q(r)}; UPDATE helper_selection.leases SET state='RELEASED' WHERE id={q(r)}");ok('legacy deployment commit/release')
   sql(legacy,legacy_insert('RUNTIME',device=other),'legacy_selection_fk');ok('legacy FK preserved')
   sql(legacy,legacy_insert('RECOVERY'),'LIFECYCLE_DIRECT_WRITE_DENIED');ok('broad legacy INSERT cannot select RECOVERY')
   sql(legacy,f"UPDATE helper_selection.leases SET kind='RECOVERY' WHERE id={q(rid)}",'HELPER_LEASE_HISTORY_REWRITE_DENIED');ok('legacy kind rewrite denied')
   sql(legacy,f"UPDATE core_dispatch.authorities SET lifecycle_head={q('a'*64)} WHERE authority_id={q(a)}",'permission denied');sql(admin,'GRANT UPDATE ON core_dispatch.authorities TO nx_fixture_legacy');sql(legacy,f"UPDATE core_dispatch.authorities SET lifecycle_head={q('a'*64)} WHERE authority_id={q(a)}",'LIFECYCLE_ANCHOR_DIRECT_WRITE_DENIED');ok('legacy direct anchor update denied even with broad UPDATE')
   # Broad selection INSERT has to be denied by guard, not merely the usual ACL.
   sql(admin,'GRANT INSERT ON helper_selection.selections TO nx_fixture_legacy')
   surviving=uid();sql(legacy,legacy_insert('RUNTIME',surviving));ok('legacy survives until independent drain; no implicit release')
   sql(legacy,f"UPDATE core_dispatch.authorities SET max_seen_ms=max_seen_ms WHERE authority_id={q(a)}");ok('unanchored legacy clock transaction preserved')
   state,ca,source,target,job,claim=cases[-1]
   sql(legacy,f"INSERT INTO transfer_authority.claims(request_id,job_id,claim_id,epoch,lease_hash,intent_hash,intent,state) VALUES({q(uid())},{q(job)},{q(uid())},1,{q('a'*64)},{q('b'*64)},'{{}}'::jsonb,'NO_EFFECT')");ok('unanchored transfer claim INSERT retained')
   sql(admin,'GRANT TRUNCATE ON transfer_authority.claims TO nx_fixture_legacy');sql(legacy,'TRUNCATE transfer_authority.claims','LIFECYCLE_HISTORY_TRUNCATE_DENIED');ok('raw TRUNCATE cannot erase transfer tombstones')
   # Fixture-only genesis. Never ship this operator bypass as production provisioning.
   sql(admin,f"ALTER TABLE core_dispatch.authorities DISABLE TRIGGER lifecycle_anchor_guard; UPDATE core_dispatch.authorities SET lifecycle_store_id={q(store)},lifecycle_sequence=0,lifecycle_head={q(genesis)} WHERE authority_id IN ({','.join(q(v) for v in [a,a2,repair_a,core_a]+[c[1] for c in cases])}); ALTER TABLE core_dispatch.authorities ENABLE TRIGGER lifecycle_anchor_guard;")
   sql(legacy,legacy_insert('RUNTIME'),'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('unintegrated legacy writer on anchored authority denied')
   sql(legacy,f"UPDATE helper_selection.selections SET revision={q(uid())} WHERE authority_id={q(a)}",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('legacy selection mutation on anchored authority denied')
   sql(legacy,f"INSERT INTO helper_selection.selections(authority_id,device_id,owner_id,device_epoch,session_epoch,owner_epoch,generation,broker_id,revision) VALUES({q(a)},{q(dev)},{q(owner)},{q(dep)},{q(sess)},1,1,{q(broker)},{q(rev)})",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('broad selection INSERT on anchored authority denied before uniqueness')
   sql(legacy,f"BEGIN; SELECT id FROM helper_selection.leases WHERE id={q(surviving)}; UPDATE core_dispatch.authorities SET max_seen_ms=max_seen_ms WHERE authority_id={q(a)}; COMMIT;",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');assert sql(admin,f"SELECT state FROM helper_selection.leases WHERE id={q(surviving)}")=='ACTIVE';ok('anchored legacy read transaction cannot commit even no-op clock write; lease retained')
   sql(legacy,f"UPDATE helper_selection.leases SET state='RELEASED' WHERE id={q(surviving)}",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('surviving legacy runtime cannot silently release')
   # Independent recovery on a2 has NO CORE grant or helper selection.
   def scope(**kw):
    s=dict(authorityId=a2,storeId=store,ownerAccountId=owner,ownerEpoch='1',directoryHead='a'*64,deviceId=dev,installationLineageId=dep,resourceId=other,bootId=uid(),sessionEpoch=sess,generation='1',purpose='rollback',transactionSha256='b'*64,authorizationId=uid(),attemptId=uid(),requestId=uid(),challenge='c'*64,requestSha256='d'*64,bindingSha256='e'*64,envelopeSha256='f'*64,signerSpkiSha256='1'*64,deadlineMs=int(time.time()*1000)+25000);s.update(kw);return s
   def call(s,l,seq,h,n):return f"SELECT helper_selection.stage_recovery_consume({q(json.dumps(s))}::jsonb,{q(l)},{seq},{q(h)},{q(n)})"
   def terminal(s,l,seq,h,n):return f"SELECT helper_selection.stage_recovery_terminal({q(json.dumps(s))}::jsonb,{q(l)},1,{q('2'*64)},{seq},{q(h)},{q(n)},'NO_EFFECT',{q('4'*64)})"
   # Nonterminal historical claim and pending checks apply to both endpoints,
   # including cancelled jobs; terminal APPLIED alone is not a drain blocker.
   for state,ca,source,target,job,claim in cases:
    if state=='APPLIED':continue
    for device in [source,target]:
     blocked=scope(authorityId=ca,deviceId=device);sql(consume,call(blocked,uid(),0,genesis,'2'*64),'LIFECYCLE_WRITER_DRAIN_REQUIRED');ok('nonterminal '+state+' endpoint '+('SOURCE' if device==source else 'TARGET')+' denied')
   sql(consume,call(scope(authorityId=core_a,deviceId=core_dev),uid(),0,genesis,'2'*64),'LIFECYCLE_WRITER_DRAIN_REQUIRED');ok('outstanding CORE claim denies recovery')
   state,ca,source,target,job,claim=cases[-1]
   sql(consume,call(scope(authorityId=ca,deviceId=source),uid(),0,genesis,'2'*64));ok('terminal transfer history does not itself block SQL staging; witness still required')
   state,ca,source,target,job,claim=cases[0]
   sql(legacy,f"UPDATE transfer_authority.claims SET state='APPLIED' WHERE request_id={q(claim)}",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('raw anchored transfer claim settlement denied; no bypass')
   sql(legacy,f"INSERT INTO transfer_authority.claims(request_id,job_id,claim_id,epoch,lease_hash,intent_hash,intent,state) VALUES({q(uid())},{q(job)},{q(uid())},1,{q('a'*64)},{q('b'*64)},'{{}}'::jsonb,'ACTIVE')",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('raw anchored transfer claim INSERT denied')
   sql(legacy,f"INSERT INTO transfer_authority.jobs(id,authority_id,owner_id,project_id,source_device_id,target_device_id,target_path_key,binding,epoch,lease_hash) VALUES({q(uid())},{q(ca)},{q(owner)},'fixture',{q(source)},{q(target)},'new-path','{{}}'::jsonb,1,{q('a'*64)})",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('raw anchored transfer job INSERT denied')
   sql(legacy,f"UPDATE core_dispatch.grants SET state='REVOKED' WHERE authority_id={q(ca)} AND device_id={q(source)}",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('unintegrated core grant mutation denied under anchor')
   sql(legacy,f"INSERT INTO core_dispatch.claims(request_id,authority_id,device_id,dispatch_id,broker_id,request,sequence,reserved_at_ms,reserve_expires_ms,begin_nonce,state) VALUES({q(uid())},{q(ca)},{q(source)},{q(uid())},{q(broker)},'{{}}'::jsonb,1,1,2,{q('a'*64)},'RESERVED')",'LIFECYCLE_LEGACY_WRITER_NOT_ENROLLED');ok('raw anchored CORE claim INSERT denied')
   # Separate expired historical transition; the trusted reconcile service
   # can restore its exact tombstone, but SQL cannot authenticate the witness.
   historical=scope(authorityId=repair_a,deadlineMs=1);hl=uid();hc=call(historical,hl,0,genesis,'2'*64);hr=hc.replace('stage_recovery_consume','restore_recovery_consume');hi=hc.replace('stage_recovery_consume','stage_recovery_consume_internal')[:-1]+',true)'
   sql(consume,hc,'LIFECYCLE_SCOPE_OR_ANCHOR_DENIED');sql(consume,hr,'permission denied');sql(recon,hi,'permission denied');ok('expired fresh consume denied and historical restore role isolated')
   sql(recon,hr);assert sql(admin,f"SELECT state||':'||(lifecycle_scope->>'deadlineMs') FROM helper_selection.leases WHERE id={q(hl)}")=='ACTIVE:1';ok('historical reconstruction preserves expired scope and occupied tombstone')
   sql(recon,hr,'LIFECYCLE_SCOPE_OR_ANCHOR_DENIED');ok('historical reconstruction SQL CAS cannot replay')
   s=scope();l=uid();c=call(s,l,0,genesis,'2'*64)
   sql(legacy,c,'permission denied');sql(recon,c,'permission denied');ok('consume EXECUTE role separated')
   sql(consume,legacy_insert('RECOVERY'),'permission denied');ok('consume role cannot direct INSERT')
   sql(consume,call({**s,'ownerEpoch':'invalid'},l,0,genesis,'2'*64),'LIFECYCLE_SCOPE_SHAPE_DENIED');ok('malformed scope rejected')
   # Real two psql connections. First waits after staged row while holding row lock.
   first=subprocess.Popen(args(consume)+['-c',f'BEGIN; {c}; SELECT pg_sleep(2); COMMIT;'],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   try:
    for _ in range(50):
     if sql(admin,"SELECT count(*) FROM pg_stat_activity WHERE usename='nx_fixture_consume' AND wait_event='PgSleep'")=='1':break
     if first.poll() is not None:raise AssertionError(first.communicate())
     time.sleep(.05)
    else:raise AssertionError('first connection never reached lock-held phase')
    s2=scope(purpose='coordinated-uninstall',transactionSha256='5'*64);sql(consume,call(s2,uid(),0,genesis,'3'*64),'LIFECYCLE_SCOPE_OR_ANCHOR_DENIED')
    out,err=first.communicate(timeout=10);assert first.returncode==0,out+err
   finally:
    if first.poll() is None:first.kill();first.communicate()
   assert sql(admin,f"SELECT count(*) FROM helper_selection.leases WHERE authority_id={q(a2)} AND state='ACTIVE'")=='1';ok('real concurrent cross-purpose CAS one row; no CORE grant')
   # A service with the staging role can commit without the independent CAS.
   # This is the expected SQL-only counterexample, NOT authority acceptance.
   observed=sql(admin,f"SELECT lifecycle_sequence||':'||lifecycle_head FROM core_dispatch.authorities WHERE authority_id={q(a2)}")
   assert observed=='1:'+('2'*64) and observed!='0:'+genesis
   print('COUNTEREXAMPLE_UNANCHORED_COMMIT_REPRODUCED local head ahead of unchanged fixture witness; effect ACK NOT_RUN',flush=True)
   sql(legacy,f"UPDATE helper_selection.leases SET state='RELEASED',terminal_sequence=2,terminal_head={q('3'*64)},terminal_evidence_sha256={q('4'*64)},terminal_outcome='NO_EFFECT' WHERE id={q(l)}",'LIFECYCLE_DIRECT_WRITE_DENIED');ok('legacy cannot release recovery')
   t=terminal(s,l,1,'2'*64,'3'*64);sql(consume,t,'permission denied');ok('consume cannot reconcile')
   sql(recon,terminal({**s,'ownerEpoch':'2'},l,1,'2'*64,'3'*64),'LIFECYCLE_TERMINAL_CAS_FAILED');ok('terminal exact immutable original scope')
   sql(recon,t);assert sql(admin,f"SELECT state||':'||terminal_outcome FROM helper_selection.leases WHERE id={q(l)}")=='RELEASED:NO_EFFECT';ok('terminal SQL CAS retains tombstone')
   replay={**s,'requestId':uid(),'attemptId':uid(),'deadlineMs':int(time.time()*1000)+20000};sql(consume,call(replay,uid(),2,'3'*64,'5'*64),'LIFECYCLE_REPLAY_OR_CONFLICT');ok('new request/attempt cannot resurrect consumed transaction')
   print(f'SQL_ROLE_FIXTURE {passed} PASS; witness and physical acceptance NOT_RUN')
  finally:
   if started:must(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'])
if __name__=='__main__':main()
