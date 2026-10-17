"""
Naveax DEV smoke. Generates an Ed25519 PRIVATE KEY IN THIS PROCESS RAM only.
Prints DER public key for operator-approved registration; never emits private
key, never persists it. Waits for transient owner WSS config and signs locally.
Requirements already installed: cryptography, websocket-client.
"""
import os, sys, json, time, secrets, hashlib, base64, ssl, websocket
from pathlib import Path
from urllib.parse import urlsplit
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat

config_path=Path(os.environ.get("NEXOWIRE_DEV_CLIENT_CONFIG",
    r"D:\Temp\nexowire-tailnet-device-held-wss.json"))
private=Ed25519PrivateKey.generate()
public_der=private.public_key().public_bytes(Encoding.DER,PublicFormat.SubjectPublicKeyInfo)
print("DEV_PUBLIC_DER="+base64.b64encode(public_der).decode("ascii"),flush=True)
deadline=time.monotonic()+95
while not config_path.is_file():
    if time.monotonic()>deadline:
        print(json.dumps({"passed":False,"error":"config_timeout"}),flush=True)
        sys.exit(2)
    time.sleep(0.15)
try:
    cfg=json.loads(config_path.read_text(encoding="utf-8"))
finally:
    config_path.unlink(missing_ok=True)
hostname=urlsplit(cfg["url"]).hostname
assert cfg["url"].startswith("wss://100."), "unexpected private owner"
assert hostname is not None
os.environ["NO_PROXY"]=hostname
os.environ["no_proxy"]=hostname
context=ssl.create_default_context(cadata=cfg["certPem"])
context.minimum_version=ssl.TLSVersion.TLSv1_3
context.maximum_version=ssl.TLSVersion.TLSv1_3
context.check_hostname=True
context.verify_mode=ssl.CERT_REQUIRED
ws=None
try:
    ws=websocket.create_connection(cfg["url"],timeout=8,sslopt={"context":context},
        http_no_proxy=[hostname],enable_multithread=True)
    tls=ws.sock.version()
    if tls!="TLSv1.3":raise RuntimeError("tls_downgrade")
    leaf=hashlib.sha256(ws.sock.getpeercert(binary_form=True)).hexdigest()
    if leaf.lower()!=cfg["sha256"].lower():raise RuntimeError("wrong_leaf_pin")
    nonce="nonce-devheld-"+secrets.token_hex(12)
    invocation="invocation-devheld-"+secrets.token_hex(12)
    now=int(time.time()*1000)
    body={"bearerToken":cfg["bearerToken"],"invocationId":invocation,
        "toolId":cfg["toolId"]}
    def canonical(v):
        return json.dumps(v,separators=(",",":"),ensure_ascii=False).encode("utf8")
    body_hash=hashlib.sha256(canonical([
        body["bearerToken"],body["invocationId"],body["toolId"],
    ])).hexdigest()
    content=canonical([
        "nexowire-owner-quota-rpc-v1","POST",
        "/internal/owner-quota/v1/reserve",1,cfg["deviceId"],
        nonce,now,body_hash,
    ])
    signature=base64.urlsafe_b64encode(private.sign(content)).decode("ascii").rstrip("=")
    envelope={
        "version":1,"deviceId":cfg["deviceId"],"nonce":nonce,
        "issuedAtMs":now,"body":body,"signatureBase64url":signature,
    }
    frame=lambda reqid:{"version":1,"kind":"reserve","requestId":reqid,
        "envelope":envelope}
    ws.send(json.dumps(frame("memory-held-first-001"),separators=(",",":")))
    first=json.loads(ws.recv())
    ws.send(json.dumps(frame("memory-held-replay-002"),separators=(",",":")))
    replay=json.loads(ws.recv())
    decision=first.get("data",{}).get("decision",{})
    result={
        "passed":tls=="TLSv1.3" and first.get("httpStatus")==200 and
            decision.get("status")=="reserved" and
            decision.get("authorizesToolExecution") is False and
            replay.get("httpStatus")==409,
        "tls":tls,"leafPin":True,
        "firstStatus":first.get("httpStatus"),
        "firstDecision":decision.get("status"),
        "executionAuthorized":decision.get("authorizesToolExecution"),
        "replayStatus":replay.get("httpStatus"),
        "privateKeyStayedInClientRAM":True,
    }
    print(json.dumps(result),flush=True)
    if not result["passed"]:sys.exit(4)
except Exception as e:
    print(json.dumps({"passed":False,"errorType":type(e).__name__,
        "error":str(e)[:180]}),flush=True)
    sys.exit(3)
finally:
    if ws is not None:ws.close()
