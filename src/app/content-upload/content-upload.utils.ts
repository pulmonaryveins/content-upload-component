import {
  ALLOWED_MIME_TYPES,
  FILENAME_INVALID_CHARS_REGEX,
  MAX_FILE_SIZE_IMAGE,
  MAX_FILE_SIZE_VIDEO,
  MIME_TO_LABEL,
} from './content-upload.constants';
import type { DuplicateInfo, UploadFile, ValidationError } from './content-upload.types';

/**
 * Validates a browser File against type, filename, and size rules.
 * Returns a ValidationError if invalid, null if valid.
 * Tests in order: type → special chars → size.
 * Caller must set fileId on the returned error.
 */
export function validateFile(file: File): Omit<ValidationError, 'fileId'> | null {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    const typeDisplay = file.type || 'unknown';
    return {
      filename: file.name,
      type: 'unsupported-type',
      message: `File type ${typeDisplay} is not supported. Supported types: PNG, JPEG, JPG, MP4, WEBM`,
    };
  }

  const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
  if (FILENAME_INVALID_CHARS_REGEX.test(nameWithoutExt)) {
    return {
      filename: file.name,
      type: 'special-chars',
      message: `File names cannot contain special characters including spaces and parenthesis`,
    };
  }

  const isVideo = file.type.startsWith('video/');
  const maxSize = isVideo ? MAX_FILE_SIZE_VIDEO : MAX_FILE_SIZE_IMAGE;
  if (file.size > maxSize) {
    return {
      filename: file.name,
      type: 'file-too-large',
      message: `File ${file.name} exceeds the maximum size of ${formatFileSize(maxSize)}`,
    };
  }

  return null;
}

/**
 * Creates a safe object URL for image and video previews.
 * Caller is responsible for calling URL.revokeObjectURL() on cleanup.
 */
export function generatePreviewUrl(file: File): string | null {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
    return URL.createObjectURL(file);
  }
  return null;
}

/** Strips file extension: "my-photo.jpg" → "my-photo" */
export function getBaseName(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '');
}

/** Maps MIME type to display label: "image/jpeg" → "JPEG" */
export function getMimeLabel(mimeType: string): string {
  return MIME_TO_LABEL[mimeType] ?? mimeType.split('/')[1]?.toUpperCase() ?? 'UNKNOWN';
}

/**
 * Sanitizes a user-supplied rename string:
 * trims → replaces spaces with hyphens → strips invalid chars.
 */
export function sanitizeFilename(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_]/g, '');
}

/** Formats bytes into human-readable string using SI units. */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1000));
  const value = bytes / Math.pow(1000, i);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Detects duplicates within the new files list and against existing library titles.
 * Returns a DuplicateInfo for every file that conflicts.
 */
export function detectDuplicates(
  files: UploadFile[],
  existingTitles: ReadonlyArray<string>
): DuplicateInfo[] {
  const duplicates: DuplicateInfo[] = [];
  const allKnown = new Set<string>(existingTitles.map((t) => t.toLowerCase()));
  const seenInBatch = new Map<string, string>(); // lowerName → first file id

  for (const file of files) {
    const lower = file.name.toLowerCase();

    if (allKnown.has(lower) || seenInBatch.has(lower)) {
      const suggested = generateUniqueName(file.name, allKnown, seenInBatch);
      duplicates.push({
        fileId: file.id,
        currentName: file.name,
        suggestedName: suggested,
        resolved: false,
      });
    } else {
      seenInBatch.set(lower, file.id);
      allKnown.add(lower);
    }
  }

  return duplicates;
}

/**
 * Generates a unique name using the standard incremental suffix: name(1), name(2), ...
 * Matches Channels Filename Validation: e.g. test.png, test(1).png, test(2).png
 */
function generateUniqueName(
  name: string,
  existing: Set<string>,
  batchSeen: Map<string, string>
): string {
  let counter = 1;
  let candidate = `${name}(${counter})`;
  while (existing.has(candidate.toLowerCase()) || batchSeen.has(candidate.toLowerCase())) {
    counter++;
    candidate = `${name}(${counter})`;
  }
  return candidate;
}
