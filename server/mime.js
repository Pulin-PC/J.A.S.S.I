// One plain-text email in the form Gmail's API wants (RFC 2822, base64url). No header can be smuggled in:
// the address is checked, the subject is encoded, and the body is base64.
const enc = new TextEncoder();
const b64 = s => { let bin = ""; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
export const isEmail = s => /^[^\s@<>,;:"'\\()[\]]+@[^\s@<>,;:"'\\()[\]]+\.[a-z]{2,}$/i.test(String(s || ""));

export function rawEmail({ to, subject = "", text = "" }) {
  if (!isEmail(to)) throw new Error("that isn't an email address");
  const body = (b64(String(text)).match(/.{1,76}/g) || [""]).join("\r\n");
  const mail = [`To: ${to}`, `Subject: =?UTF-8?B?${b64(String(subject).replace(/[\r\n]+/g, " ").slice(0, 200))}?=`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  return b64(mail).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
