export interface BackupGuide {
  id: string
  appName: string
  appInitials: string
  difficulty: 'easy' | 'medium' | 'manual'
  steps: string[]
  note?: string
}

export const guides: BackupGuide[] = [
  {
    id: 'whatsapp',
    appName: 'WhatsApp',
    appInitials: 'WA',
    difficulty: 'easy',
    steps: [
      'Open WhatsApp and navigate to the chat you want to back up.',
      'Tap the contact or group name at the top.',
      'Scroll down and tap "Export Chat".',
      'Choose "Include Media" when prompted.',
      'Select "Beebeeb" from the share sheet.',
    ],
    note: 'Exports one chat at a time. Repeat per chat for a full backup.',
  },
  {
    id: 'telegram',
    appName: 'Telegram',
    appInitials: 'TG',
    difficulty: 'medium',
    steps: [
      'Open Telegram Desktop on your computer (export is desktop-only).',
      'Go to Settings → Advanced → Export Telegram Data.',
      'Select what to include: messages, photos, videos.',
      'Click Export and wait for the archive to finish.',
      'Transfer the archive to your phone via AirDrop or USB.',
      'Open Beebeeb and upload the archive.',
    ],
    note: 'Export is only available on Telegram Desktop, not the mobile app.',
  },
  {
    id: 'instagram',
    appName: 'Instagram',
    appInitials: 'IG',
    difficulty: 'medium',
    steps: [
      'Open Instagram and go to your profile.',
      'Tap the three-line menu → Your Activity → Download your information.',
      'Select "Download or transfer information" → "Some of your information".',
      'Choose Photos and videos, then tap Download to device.',
      'Instagram will send a notification when the archive is ready (up to 48 hours).',
      'Open the downloaded ZIP and share photos to Beebeeb.',
    ],
    note: 'Instagram can take up to 48 hours to prepare your archive.',
  },
  {
    id: 'signal',
    appName: 'Signal',
    appInitials: 'SG',
    difficulty: 'manual',
    steps: [
      'Signal does not support exporting individual conversations.',
      'On iPhone: go to Settings → Chats → Create Linked Device to transfer to a new phone.',
      'For partial backup: take screenshots of important conversations.',
      'For media: save individual photos and videos to your camera roll, then back them up via Beebeeb camera backup.',
    ],
    note: 'Signal prioritises privacy by design — full export is not available. Your messages live on your device only.',
  },
  {
    id: 'apple-notes',
    appName: 'Apple Notes',
    appInitials: 'AN',
    difficulty: 'easy',
    steps: [
      'Open the Notes app.',
      'Open any note you want to save.',
      'Tap the Share button (box with an arrow).',
      'Choose "Send a Copy" → PDF or Rich Text.',
      'Select "Beebeeb" from the share sheet.',
    ],
    note: 'Export one note at a time. For bulk export, use a Mac: File → Export As PDF.',
  },
  {
    id: 'google-photos',
    appName: 'Google Photos',
    appInitials: 'GP',
    difficulty: 'easy',
    steps: [
      'Open Google Photos.',
      'Tap your profile picture → Photos settings → Back up.',
      'Alternatively, go to takeout.google.com to download your full library.',
      'Select Google Photos and choose your export format.',
      'Download the archive and share the photos to Beebeeb.',
    ],
    note: 'Google Takeout archives can be several GB. Download via Wi-Fi.',
  },
]
