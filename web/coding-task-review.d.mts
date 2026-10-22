export type TaskReviewIntent={
  readonly kind:'NEXOWIRE_CODING_REVIEW_INTENT_REQUEST_V1';
  readonly scope:Readonly<Record<string,string|number>>;
  readonly requestedAtMs:number;
  readonly expiresAtMs:number;
  readonly requestedAction:'REVIEW_PATCH';
  readonly signedApproval:false; readonly consumedApproval:false;
  readonly canDispatch:false;readonly canApply:false;readonly canRollback:false;
  readonly nativeHigh:false;readonly externalCasWitness:false;
};
export type TaskReviewProjection={
  readonly status:'BLOCKED'|'REVIEW_INTENT_ONLY';
  readonly reasons:readonly string[];
  readonly canRecordIntent:boolean;readonly canDispatch:false;
  readonly canApply:false;readonly canRollback:false;
  readonly effectiveWindowsHigh:false;readonly physicalVerified:false;
  readonly scope:Readonly<Record<string,string|number>>;
  readonly files:readonly {path:string;status:string;additions:number;deletions:number}[];
  readonly additions:number;readonly deletions:number;
  readonly diff:string;readonly diffTruncated:boolean;
  readonly deadlineMs:number|null;
  readonly sourceEvidence:string;readonly physicalEvidence:string;
  readonly postEffectWarning:string;
};
export function projectTaskReview(input:any,nowMs?:number):TaskReviewProjection;
export function makeReviewIntent(input:any,nowMs?:number):TaskReviewIntent|null;
export function mountTaskReview(root:any,input:any,options?:{
  now?:()=>number;
  onIntent?:(intent:TaskReviewIntent)=>void;
}):Readonly<{view:TaskReviewProjection;button:any;message:any}>;
