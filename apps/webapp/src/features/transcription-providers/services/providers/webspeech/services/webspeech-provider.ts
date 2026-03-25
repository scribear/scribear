import { BaseProviderInterface } from '../../base-provider-interface';
import type { ProviderInterface } from '../../provider-interface';
import {
  INITIAL_WEBSPEECH_STATUS,
  languageTags,
  type WebspeechConfig,
} from '../config/webspeech-config';
import { WebspeechStatus } from '../types/webspeech-status';

let lastWebspeechErrorDetail: string | null = null;

export const getLastWebspeechErrorDetail = () => {
  return lastWebspeechErrorDetail;
};

const resolveSupportedLanguageTag = (tag: string): string | null => {
  if (tag in languageTags) return tag;

  try {
    const locale = new Intl.Locale(tag).maximize();
    const maximizedTag =
      locale.region !== undefined
        ? `${locale.language}-${locale.region}`
        : locale.language;

    if (maximizedTag in languageTags) {
      return maximizedTag;
    }

    const matchedTag = Object.keys(languageTags).find((supportedTag) =>
      supportedTag.startsWith(`${locale.language}-`),
    );
    if (matchedTag) return matchedTag;
  } catch {
    const [baseLanguage] = tag.split('-');
    if (!baseLanguage) return null;

    const matchedTag = Object.keys(languageTags).find((supportedTag) =>
      supportedTag.startsWith(`${baseLanguage}-`),
    );
    if (matchedTag) return matchedTag;
  }

  return null;
};

const resolveAutoLanguageTag = (): string | null => {
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter((tag): tag is string => tag !== '');

  for (const tag of candidates) {
    const resolvedTag = resolveSupportedLanguageTag(tag);
    if (resolvedTag !== null) return resolvedTag;
  }

  return null;
};

export class WebspeechProvider
  extends BaseProviderInterface<WebspeechStatus>
  implements ProviderInterface<WebspeechConfig, WebspeechStatus>
{
  private _muted = true;
  private _recognition: SpeechRecognition | null;
  private _finalizedResultCount: number;
  private _providerIsStarted: boolean;

  constructor() {
    super(INITIAL_WEBSPEECH_STATUS);
    this._recognition = null;
    this._finalizedResultCount = 0;
    this._providerIsStarted = false;
  }

  private _handleResult(event: SpeechRecognitionEvent) {
    const { results } = event;

    for (let i = this._finalizedResultCount; i < results.length; i++) {
      const result = results.item(i);
      const alternative = result.item(0);
      if (result.isFinal) {
        this._appendFinalizedTranscription({ text: [alternative.transcript] });
        this._finalizedResultCount = i + 1;
      }
    }

    const inProgress: string[] = [];
    for (let i = this._finalizedResultCount; i < results.length; i++) {
      const result = results.item(i);
      const alternative = result.item(0);
      if (!result.isFinal) {
        inProgress.push(alternative.transcript);
      }
    }

    if (inProgress.length > 0) {
      this._replaceInProgressTranscription({ text: inProgress });
    }
  }

  private _handleError(event: SpeechRecognitionErrorEvent) {
    if (event.error === 'no-speech') {
      this._commitParagraphBreak();
      return;
    }

    // Can happen during intentional stop/restart cycles.
    if (event.error === 'aborted') {
      if (
        this._muted ||
        this.status === WebspeechStatus.INACTIVE ||
        this.status === WebspeechStatus.ACTIVE_MUTE
      ) {
        return;
      }
    }

    const errorDetail =
      event.message !== ''
        ? `${event.error}: ${event.message}`
        : `${event.error}`;
    lastWebspeechErrorDetail = errorDetail;

    console.error('Webspeech encountered unexpected error', event);
    this._setStatus(WebspeechStatus.ERROR);
  }

  private _handleEnd() {
    this._finalizedResultCount = 0;
    this._providerIsStarted = false;

    if (this.status === WebspeechStatus.ACTIVE && this._recognition) {
      try {
        this._recognition.start();
        this._providerIsStarted = true;
      } catch (error) {
        console.error('Failed to restart webspeech recognition', error);
      }
    }
  }

  private _createRecognition(config: WebspeechConfig) {
    const Recognition =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      window.SpeechRecognition || window.webkitSpeechRecognition;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!Recognition) {
      return null;
    }

    const recognition = new Recognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    const resolvedLanguageTag =
      config.languageTag !== '' ? config.languageTag : resolveAutoLanguageTag();
    if (resolvedLanguageTag !== null) {
      recognition.lang = resolvedLanguageTag;
    }

    recognition.onresult = this._handleResult.bind(this);
    recognition.onerror = this._handleError.bind(this);
    recognition.onend = this._handleEnd.bind(this);

    return recognition;
  }

  private _startProvider() {
    if (!this._recognition) return;

    try {
      this._recognition.start();
      this._providerIsStarted = true;
      this._setStatus(WebspeechStatus.ACTIVE);
    } catch (error) {
      console.error('Failed to start webspeech recognition', error);
      this._setStatus(WebspeechStatus.ERROR);
    }
  }

  private _pauseProvider() {
    if (!this._recognition) return;

    if (this._providerIsStarted) {
      this._recognition.stop();
      this._providerIsStarted = false;
    }

    this._setStatus(WebspeechStatus.ACTIVE_MUTE);
  }

  private _stopProvider() {
    if (this._recognition && this._providerIsStarted) {
      this._recognition.stop();
    }

    this._providerIsStarted = false;
    this._finalizedResultCount = 0;
    this._setStatus(WebspeechStatus.INACTIVE);
  }

  activateProvider(config: WebspeechConfig) {
    lastWebspeechErrorDetail = null;
    this._setStatus(WebspeechStatus.ACTIVATING);

    try {
      this._recognition = this._createRecognition(config);
    } catch (error) {
      console.error('Failed to activate webspeech', error);
      this._setStatus(WebspeechStatus.ERROR);
      return;
    }

    if (this._recognition === null) {
      this._setStatus(WebspeechStatus.UNSUPPORTED);
      return;
    }

    if (this._muted) {
      this._pauseProvider();
    } else {
      this._startProvider();
    }
  }

  deactivateProvider() {
    this._stopProvider();
    this._recognition = null;
  }

  unmute() {
    this._muted = false;
    if (this.status === WebspeechStatus.ACTIVE_MUTE) {
      this._startProvider();
    }
  }

  mute() {
    this._muted = true;
    if (this.status === WebspeechStatus.ACTIVE) {
      this._setStatus(WebspeechStatus.ACTIVE_MUTE);
      this._pauseProvider();
    }
  }
}
