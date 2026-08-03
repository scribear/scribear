import { useState } from 'react';

import TranslateIcon from '@mui/icons-material/Translate';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';

import { ChoiceModal, DrawerMenuGroup } from '@scribear/core-ui';
import {
  type TranslationLanguageOption,
  languageDisplayName,
} from '@scribear/live-translation-store';

import { TRANSLATION_DISCLAIMER } from './translated-captions-panel.js';

/** What the confirmation dialog is currently gating. */
type PendingAction =
  | { kind: 'enable'; language: string; requiresDownload: boolean }
  | { kind: 'switch'; language: string; requiresDownload: boolean }
  | { kind: 'disable' };

/**
 * Props for {@link LiveTranslationMenu}.
 */
export interface LiveTranslationMenuProps {
  // Whether this browser exposes the Translator API. When false the entire
  // menu is omitted - there is nothing here a user could act on.
  isSupported: boolean;
  // Whether the user currently has translated captions turned on.
  isEnabled: boolean;
  // The selected BCP-47 target language tag.
  targetLanguage: string;
  // Target languages this browser reported as usable, sorted for display.
  languages: TranslationLanguageOption[];
  // Turns translation on for the given language. Called from the confirm
  // click, so the browser still sees user activation for the model download.
  onEnable: (language: string) => void;
  // Turns translation off.
  onDisable: () => void;
  // Changes the target language.
  onChangeLanguage: (language: string) => void;
}

/**
 * Message shown before anything is downloaded or translated.
 *
 * Both halves of this are required by the feature's terms of use: a warning
 * that proceeding may stall on a download, and a statement that the output is
 * machine-produced and can be wrong.
 */
function confirmationMessage(
  action: PendingAction,
  languageLabel: string,
): string {
  if (action.kind === 'disable') {
    return 'Turn off translated captions? The original captions stay on screen.';
  }
  if (action.requiresDownload) {
    return (
      `${languageLabel} needs a one-time language model download, which may ` +
      `take a while on a slow connection. The original captions keep running ` +
      `while it downloads. ${TRANSLATION_DISCLAIMER}.`
    );
  }
  return `Show captions translated into ${languageLabel}? ${TRANSLATION_DISCLAIMER}.`;
}

/**
 * Drawer menu group for turning translated captions on and picking a language.
 *
 * Every state change here is gated behind an explicit confirmation. Turning
 * translation on can spend a user's connection on a model download and puts
 * unreviewed machine output in front of someone who may be depending on
 * captions to follow the room, so neither is done on a stray tap.
 */
export const LiveTranslationMenu = ({
  isSupported,
  isEnabled,
  targetLanguage,
  languages,
  onEnable,
  onDisable,
  onChangeLanguage,
}: LiveTranslationMenuProps) => {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );

  if (!isSupported) return null;

  const requiresDownloadFor = (code: string) =>
    languages.find((language) => language.code === code)?.requiresDownload ??
    // Unknown to the probe (still running, or an unlisted stored preference):
    // assume a download, because warning about one that does not happen is
    // harmless and the reverse is not.
    true;

  const handleToggle = (checked: boolean) => {
    setPendingAction(
      checked
        ? {
            kind: 'enable',
            language: targetLanguage,
            requiresDownload: requiresDownloadFor(targetLanguage),
          }
        : { kind: 'disable' },
    );
  };

  const handleLanguageSelected = (code: string) => {
    if (code === targetLanguage) return;
    if (!isEnabled) {
      // Nothing is running and nothing downloads until translation is turned
      // on, so picking a language needs no confirmation of its own.
      onChangeLanguage(code);
      return;
    }
    setPendingAction({
      kind: 'switch',
      language: code,
      requiresDownload: requiresDownloadFor(code),
    });
  };

  const confirmPendingAction = () => {
    if (!pendingAction) return;
    if (pendingAction.kind === 'disable') {
      onDisable();
    } else if (pendingAction.kind === 'enable') {
      onEnable(pendingAction.language);
    } else {
      onChangeLanguage(pendingAction.language);
    }
    setPendingAction(null);
  };

  const pendingLanguageLabel =
    pendingAction && pendingAction.kind !== 'disable'
      ? languageDisplayName(pendingAction.language)
      : '';

  return (
    <DrawerMenuGroup summary="Translated Captions" icon={<TranslateIcon />}>
      <FormControlLabel
        control={
          <Switch
            checked={isEnabled}
            onChange={(event) => {
              handleToggle(event.target.checked);
            }}
            slotProps={{ input: { 'aria-label': 'Show translated captions' } }}
          />
        }
        label="Show translated captions"
      />

      <FormControl fullWidth size="small" sx={{ mt: 2 }}>
        <InputLabel id="translation-language-label">Language</InputLabel>
        <Select
          labelId="translation-language-label"
          label="Language"
          value={
            languages.some((l) => l.code === targetLanguage)
              ? targetLanguage
              : ''
          }
          onChange={(event) => {
            handleLanguageSelected(event.target.value);
          }}
        >
          {languages.map((language) => (
            <MenuItem key={language.code} value={language.code}>
              {language.requiresDownload
                ? `${language.label} (download required)`
                : language.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {languages.length === 0 && (
        <Typography variant="body2" component="p" sx={{ mt: 1 }}>
          Checking which languages this browser can translate into...
        </Typography>
      )}

      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ mt: 2 }}
      >
        {`${TRANSLATION_DISCLAIMER}. The original captions are always kept.`}
      </Typography>

      <ChoiceModal
        isOpen={pendingAction !== null}
        message={
          pendingAction
            ? confirmationMessage(pendingAction, pendingLanguageLabel)
            : ''
        }
        rightAction={
          pendingAction?.kind === 'disable'
            ? 'Turn off'
            : pendingAction?.requiresDownload
              ? 'Download and translate'
              : 'Translate'
        }
        onCancel={() => {
          setPendingAction(null);
        }}
        onRightAction={confirmPendingAction}
      />
    </DrawerMenuGroup>
  );
};
