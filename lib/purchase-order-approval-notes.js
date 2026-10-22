'use strict';

// Keep the approver's decision context on the existing durable PO notes field.
// This avoids schema changes, and still reads older purchase orders unchanged.
const singleLine=value=>String(value??'').replace(/\s+/g,' ').trim();
const optionalText=value=>String(value??'').trim();
const invalid=message=>Object.assign(new Error(message),{code:'PO_APPROVAL_NOTES_INVALID'});
function buildApprovalNotes({approval_purpose,requested_for,notes,source_notes}={}){
 const purpose=singleLine(approval_purpose),recipient=singleLine(requested_for);
 const extra=optionalText(notes),source=optionalText(source_notes);
 if(!purpose&&!recipient)return extra||source||null; // Legacy API/quoted POs remain compatible.
 if(!purpose)throw invalid('Explain why the purchase order is needed.');
 if(!recipient)throw invalid('Specify who or what the purchase order is for.');
 if(purpose.length>600||recipient.length>250||extra.length>4000)
   throw invalid('Purchase order approval notes exceed the allowed length.');
 return [
  'Reason for purchase: '+purpose,
  'Requested for: '+recipient,
  ...(extra?['Additional notes: '+extra]:[]),
  ...(source?['Source purchase request notes: '+source]:[])
 ].join('\n');
}
function extractApprovalNotes(notes){
 const raw=optionalText(notes);
 const lines=raw.split('\n');
 const reason=lines[0]?.startsWith('Reason for purchase: ')?lines[0].slice(21).trim():'';
 const requestedFor=reason&&lines[1]?.startsWith('Requested for: ')?lines[1].slice(15).trim():'';
 if(!reason||!requestedFor)return{approval_purpose:'',requested_for:'',additional_notes:raw};
 const remainder=lines.slice(2).join('\n').replace(/^Additional notes: /,'').trim();
 return{approval_purpose:reason,requested_for:requestedFor,additional_notes:remainder};
}
function withApprovalBrief(row){return row?{...row,...extractApprovalNotes(row.notes)}:row;}
module.exports={buildApprovalNotes,extractApprovalNotes,withApprovalBrief};
