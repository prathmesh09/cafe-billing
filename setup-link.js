// The setup link: one address that connects a phone when it is opened.
//
//   <app address>#c=<script>~<passcode>            a counter phone
//   <app address>#c=<script>~<passcode>&k=<kitchen> a kitchen screen
//
// <script> is the id of a Google script address, or any other address written out whole.
// Everything sits after the #, which browsers never send to a server. The sheet script
// builds the same link (setupLink in apps-script/Code.gs) and shows it as a QR code.

const GOOGLE_ADDRESS = /^https:\/\/script\.google\.com\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/;
const GOOGLE_ID = /^[A-Za-z0-9_-]{20,}$/;
const WEB_ADDRESS = /^https?:\/\//i;

export function buildSetupLink(appUrl, scriptUrl, passcode, kitchen = '') {
  const google = GOOGLE_ADDRESS.exec(scriptUrl);
  const script = google ? google[1] : encodeURIComponent(scriptUrl);
  const role = kitchen ? `&k=${encodeURIComponent(kitchen)}` : '';
  return `${appUrl}#c=${script}~${encodeURIComponent(passcode)}${role}`;
}

// Returns { scriptUrl, passcode, kitchen }, or null when the text is not a complete setup
// code. kitchen is '' for a counter phone.
export function parseSetupHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#c=')) return null;
  let payload = hash.slice(3);
  let kitchen = '';
  const roleAt = payload.indexOf('&k=');
  if (roleAt >= 0) {
    try {
      kitchen = decodeURIComponent(payload.slice(roleAt + 3));
    } catch {
      return null;
    }
    payload = payload.slice(0, roleAt);
  }
  const cut = payload.indexOf('~');
  if (cut < 1) return null;
  let script;
  let passcode;
  try {
    script = decodeURIComponent(payload.slice(0, cut));
    passcode = decodeURIComponent(payload.slice(cut + 1));
  } catch {
    return null;
  }
  if (!passcode) return null;
  if (WEB_ADDRESS.test(script)) return { scriptUrl: script, passcode, kitchen };
  if (!GOOGLE_ID.test(script)) return null;
  return { scriptUrl: `https://script.google.com/macros/s/${script}/exec`, passcode, kitchen };
}
