import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { createResearchHost } from './lib/host.mjs';
import { registerResearchBridge } from './src/register.mjs';
import { createNativeReceiptService } from './src/native-receipt-service.mjs';

export default definePluginEntry({
  id: 'openclaw-research-bridge',
  name: 'Research Candidate Bridge',
  description: 'Private test research candidates; no verification, approvals, execution or trading tools.',
  register(api) { registerResearchBridge(api, { createHost: createResearchHost, createNativeObserver: createNativeReceiptService }); },
});
