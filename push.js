// Phone alerts for kitchen phones, through OneSignal. A kitchen phone tags itself with its
// kitchen ("Fresco", "Pancham"), and the sheet script alerts only phones with that tag, so
// staff get a buzz for their kitchen's orders even while they are in another app.

import { ONESIGNAL_APP_ID } from './push-config.js';

const SDK = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
let starting = null;

export const pushAvailable = () => Boolean(ONESIGNAL_APP_ID) && 'Notification' in window && 'serviceWorker' in navigator;
export const alertsOn = () => 'Notification' in window && Notification.permission === 'granted';

// Loads OneSignal and tags this phone with its kitchen. Resolves to true when ready.
export function startPush(kitchen) {
  if (!pushAvailable()) return Promise.resolve(false);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (OneSignal) => {
      try {
        const worker = new URL('push/OneSignalSDKWorker.js', window.location.href).pathname;
        await OneSignal.init({
          appId: ONESIGNAL_APP_ID,
          serviceWorkerPath: worker.slice(1),
          serviceWorkerParam: { scope: new URL('push/', window.location.href).pathname },
        });
        await OneSignal.User.addTag('kitchen', kitchen);
        resolve(true);
      } catch {
        resolve(false);
      }
    });
    const script = document.createElement('script');
    script.src = SDK;
    script.defer = true;
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
  return starting;
}

// Shows the phone's "Allow notifications?" question. Resolves to true if allowed.
export async function askForAlerts() {
  if (!(await starting)) return false;
  try {
    await window.OneSignal.Notifications.requestPermission();
  } catch {
    return false;
  }
  return alertsOn();
}
