export const ALLOWED_MIME_TYPES: ReadonlyArray<string> = [
  'image/png',
  'image/jpeg',
  'video/mp4',
  'video/webm',
] as const;

/** Maps MIME type → display badge label */
export const MIME_TO_LABEL: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'video/mp4': 'MP4',
  'video/webm': 'WEBM',
} as const;

export const ALLOWED_EXTENSIONS: ReadonlyArray<string> = [
  'png',
  'jpg',
  'jpeg',
  'mp4',
  'webm',
] as const;

/** 50 MB */
export const MAX_FILE_SIZE_IMAGE = 50 * 1024 * 1024;

/** 500 MB */
export const MAX_FILE_SIZE_VIDEO = 500 * 1024 * 1024;

/**
 * Matches characters NOT in [a-zA-Z0-9-_].
 * No global flag — used with .test() only.
 */
export const FILENAME_INVALID_CHARS_REGEX = /[^a-zA-Z0-9\-_]/;

/** File type badge labels shown in the dropzone */
export const DROPZONE_BADGE_LABELS: ReadonlyArray<string> = [
  'PNG',
  'JPEG',
  'JPG',
  'MP4',
  'WEBM',
] as const;

/** accept attribute value for the hidden file input */
export const FILE_INPUT_ACCEPT = '.png,.jpg,.jpeg,.mp4,.webm,image/png,image/jpeg,video/mp4,video/webm';
