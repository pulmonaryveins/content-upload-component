import {
  ChangeDetectionStrategy,
  Component,
  NgZone,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import Uppy from '@uppy/core';
import Transloadit from '@uppy/transloadit';

import { environment } from '../../environments/environment';
import { DROPZONE_BADGE_LABELS, FILE_INPUT_ACCEPT } from './content-upload.constants';
import type {
  DuplicateInfo,
  OnUploadPayload,
  TransloaditAssembly,
  UploadFile,
  UploadStatus,
  ViewMode,
  ValidationError,
} from './content-upload.types';
import {
  detectDuplicates,
  formatFileSize,
  generatePreviewUrl,
  getBaseName,
  getMimeLabel,
  validateFile,
} from './content-upload.utils';

@Component({
  selector: 'app-content-upload',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './content-upload.component.html',
  styleUrl: './content-upload.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentUploadComponent implements OnInit, OnDestroy {
  // ── Services ────────────────────────────────────────────────────────────
  private readonly ngZone = inject(NgZone);

  // ── Input ────────────────────────────────────────────────────────────────
  readonly existingLibraryNames = input<string[]>([]);

  // ── Output ───────────────────────────────────────────────────────────────
  readonly onUpload = output<OnUploadPayload>();
  readonly closeRequest = output<void>();

  // ── Uppy (imperative lifecycle, not a signal) ────────────────────────────
  private uppy!: Uppy;

  // ── State Signals ────────────────────────────────────────────────────────
  readonly selectedFiles = signal<UploadFile[]>([]);
  readonly viewMode = signal<ViewMode>('grid');
  readonly isDraggingOver = signal<boolean>(false);
  readonly validationErrors = signal<ValidationError[]>([]);
  readonly duplicates = signal<DuplicateInfo[]>([]);
  readonly renamingFileId = signal<string | null>(null);
  readonly renameInputValue = signal<string>('');
  readonly uploadStatus = signal<UploadStatus>('idle');
  readonly showSuccessModal = signal<boolean>(false);

  // ── Computed Signals ─────────────────────────────────────────────────────
  readonly hasUnresolvedDuplicates = computed(() =>
    this.duplicates().some((d) => !d.resolved)
  );

  readonly unresolvedDuplicateCount = computed(() =>
    this.duplicates().filter((d) => !d.resolved).length
  );

  readonly unresolvedDuplicates = computed(() =>
    this.duplicates().filter((d) => !d.resolved)
  );

  readonly isUploadDisabled = computed(
    () =>
      this.selectedFiles().length === 0 ||
      this.hasUnresolvedDuplicates() ||
      this.uploadStatus() === 'uploading' ||
      this.validationErrors().length > 0
  );

  readonly uploadButtonLabel = computed(() => {
    if (this.hasUnresolvedDuplicates()) {
      const count = this.unresolvedDuplicateCount();
      return `Rename ${count} file${count > 1 ? 's' : ''} first`;
    }
    return `Upload (${this.selectedFiles().length}) Content`;
  });

  // ── Template-exposed constants ───────────────────────────────────────────
  readonly dropzoneBadges = DROPZONE_BADGE_LABELS;
  readonly fileInputAccept = FILE_INPUT_ACCEPT;

  // ── Lifecycle ────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.initUppy();
  }

  ngOnDestroy(): void {
    this.selectedFiles().forEach((f) => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    this.uppy.destroy();
  }

  // ── Uppy Init ────────────────────────────────────────────────────────────
  private initUppy(): void {
    this.ngZone.runOutsideAngular(() => {
      this.uppy = new Uppy({
        id: 'content-upload',
        autoProceed: false,
        allowMultipleUploadBatches: false,
        debug: !environment.production,
      });

      this.uppy.use(Transloadit, {
        assemblyOptions: {
          params: {
            auth: { key: environment.transloaditKey },
            template_id: environment.transloaditTemplateId,
          },
        },
        waitForEncoding: true,
        alwaysRunAssembly: false,
      });

      this.uppy.on('upload-progress', (file, progress) => {
        this.ngZone.run(() => {
          if (!file?.id) return;
          this.selectedFiles.update((files) =>
            files.map((f) =>
              f.id === file.id ? { ...f, progress: progress.percentage ?? null } : f
            )
          );
        });
      });

      this.uppy.on('upload-error', (_file, error) => {
        this.ngZone.run(() => {
          this.uploadStatus.set('error');
          console.error('Upload error:', error);
        });
      });

      this.uppy.on('transloadit:complete', (assembly) => {
        this.ngZone.run(() => {
          this.uploadStatus.set('complete');
          this.showSuccessModal.set(true);
          this.onUpload.emit({ status: 'uploaded', data: assembly as TransloaditAssembly });
        });
      });
    });
  }

  // ── Dropzone Handlers ────────────────────────────────────────────────────
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX >= rect.right ||
      event.clientY < rect.top ||
      event.clientY >= rect.bottom
    ) {
      this.isDraggingOver.set(false);
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDraggingOver.set(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    this.processFiles(files);
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    this.processFiles(files);
    input.value = '';
  }

  // ── File Processing Pipeline ─────────────────────────────────────────────
  private processFiles(files: File[]): void {
    const newErrors: ValidationError[] = [];
    const newUploadFiles: UploadFile[] = [];

    for (const file of files) {
      const id = crypto.randomUUID();
      const error = validateFile(file);

      if (error) {
        newErrors.push({ ...error, fileId: id });
        continue;
      }

      newUploadFiles.push({
        id,
        file,
        name: getBaseName(file.name),
        originalName: getBaseName(file.name),
        previewUrl: generatePreviewUrl(file),
        formattedSize: formatFileSize(file.size),
        typeLabel: getMimeLabel(file.type),
        progress: null,
        renamed: false,
      });
    }

    this.validationErrors.set(newErrors);
    this.selectedFiles.update((existing) => [...existing, ...newUploadFiles]);
    this.refreshDuplicates();
  }

  private refreshDuplicates(): void {
    this.duplicates.set(detectDuplicates(this.selectedFiles(), this.existingLibraryNames()));
  }

  // ── File Actions ─────────────────────────────────────────────────────────
  removeFile(fileId: string): void {
    const file = this.selectedFiles().find((f) => f.id === fileId);
    if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
    this.selectedFiles.update((files) => files.filter((f) => f.id !== fileId));
    this.duplicates.update((dupes) => dupes.filter((d) => d.fileId !== fileId));
    this.refreshDuplicates();
  }

  dismissError(fileId: string): void {
    this.validationErrors.update((errors) => errors.filter((e) => e.fileId !== fileId));
  }

  // ── Rename Flow ──────────────────────────────────────────────────────────
  startRename(fileId: string): void {
    const file = this.selectedFiles().find((f) => f.id === fileId);
    if (!file) return;
    this.renamingFileId.set(fileId);
    this.renameInputValue.set(file.name);
  }

  saveRename(): void {
    const fileId = this.renamingFileId();
    if (!fileId) return;
    const newName = this.renameInputValue().trim();
    if (!newName) return;

    this.selectedFiles.update((files) =>
      files.map((f) =>
        f.id === fileId ? { ...f, name: newName, renamed: true } : f
      )
    );
    // Mark duplicate as resolved if this was a duplicate rename
    this.duplicates.update((dupes) =>
      dupes.map((d) => (d.fileId === fileId ? { ...d, resolved: true } : d))
    );
    this.renamingFileId.set(null);
    this.renameInputValue.set('');
    this.refreshDuplicates();
  }

  cancelRename(): void {
    this.renamingFileId.set(null);
    this.renameInputValue.set('');
  }

  // ── Duplicate Resolution ─────────────────────────────────────────────────
  acceptSuggestion(fileId: string, suggestedName: string): void {
    this.selectedFiles.update((files) =>
      files.map((f) =>
        f.id === fileId ? { ...f, name: suggestedName, renamed: true } : f
      )
    );
    this.duplicates.update((dupes) =>
      dupes.map((d) => (d.fileId === fileId ? { ...d, resolved: true } : d))
    );
    this.refreshDuplicates();
  }

  openRenameForDuplicate(fileId: string): void {
    this.startRename(fileId);
  }

  isDuplicate(fileId: string): boolean {
    return this.duplicates().some((d) => d.fileId === fileId && !d.resolved);
  }

  getDuplicateInfo(fileId: string): DuplicateInfo | undefined {
    return this.duplicates().find((d) => d.fileId === fileId && !d.resolved);
  }

  isRenamed(fileId: string): boolean {
    return this.selectedFiles().find((f) => f.id === fileId)?.renamed ?? false;
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  startUpload(): void {
    if (this.isUploadDisabled()) return;

    this.uploadStatus.set('uploading');
    this.onUpload.emit({ status: 'uploading', data: null });

    this.uppy.cancelAll();

    for (const uploadFile of this.selectedFiles()) {
      this.uppy.addFile({
        id: uploadFile.id,
        name: uploadFile.name + '.' + uploadFile.file.name.split('.').pop(),
        type: uploadFile.file.type,
        data: uploadFile.file,
      });
    }

    this.uppy.upload().catch((err: unknown) => {
      this.ngZone.run(() => {
        this.uploadStatus.set('error');
        console.error('Upload failed:', err);
      });
    });
  }

  dismissSuccessModal(): void {
    this.showSuccessModal.set(false);
    this.selectedFiles.set([]);
    this.duplicates.set([]);
    this.validationErrors.set([]);
    this.uploadStatus.set('idle');
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }

}
