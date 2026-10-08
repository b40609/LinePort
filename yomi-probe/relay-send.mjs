// The public service already encrypts text; its argument must remain a string.
export function sendRelayText(service, destination, text) {
  return service.sendMessage(destination, text);
}

// Check destination key availability before entering running or marking IDs sent.
// Encryption prepares an in-memory payload only; no message is posted here.
export async function prepareRelayDestination(service, destination) {
  await service.e2eeManager.encryptE2EEMessage(destination, '', 0);
}
