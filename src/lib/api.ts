import { capturePage, submitCapture, writeToClipboard, logger } from './pipeline.js';
import { isValidFigmaEndpoint, parseHashParams } from './config.js';

if (typeof window !== 'undefined') {
  if (!window.figma) {
    window.figma = {};
  }

  window.figma.capturePage = capturePage;
  window.figma.submitCapture = submitCapture;
  window.figma.writeToClipboard = writeToClipboard;
  window.figma.isValidFigmaEndpoint = isValidFigmaEndpoint;
  window.figma.parseHashParams = parseHashParams;
  window.figma.setVerbose = (enabled: boolean) => { logger.verbose = !!enabled; };
}
