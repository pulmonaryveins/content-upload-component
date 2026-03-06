import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import Uppy from '@uppy/core';
import Transloadit, { COMPANION_ALLOWED_HOSTS, COMPANION_URL } from '@uppy/transloadit';
import GoogleDrivePicker from '@uppy/google-drive-picker';

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
  validateGDriveFile,
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
  private readonly cdr = inject(ChangeDetectorRef);

  // ── Template References ──────────────────────────────────────────────────
  @ViewChild('renamePanel') renamePanel?: { nativeElement: HTMLElement };
  @ViewChild('gdriveMount', { static: false }) gdriveMount?: ElementRef<HTMLElement>;

  // ── Input ────────────────────────────────────────────────────────────────
  readonly existingLibraryNames = input<string[]>([]);

  // ── Output ───────────────────────────────────────────────────────────────
  readonly onUpload = output<OnUploadPayload>();
  readonly closeRequest = output<void>();

  // ── Uppy (imperative lifecycle, not a signal) ────────────────────────────
  private uppy!: Uppy;
  private currentAssemblyUrl: string | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private readonly uppyManagedFileIds = new Set<string>();

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
  readonly showSuggestionDetails = signal<boolean>(false);
  readonly uploadTab = signal<'local' | 'drive'>('local');

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

  readonly firstUnresolvedDuplicate = computed(() =>
    this.unresolvedDuplicates()[0]
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
    this.clearPolling();
    const plugin = this.uppy.getPlugin('GoogleDrivePicker');
    if (plugin) {
      try { (plugin as unknown as { unmount(): void }).unmount(); } catch { /* ignore */ }
    }
    this.selectedFiles().forEach((f) => {
      if (f.previewUrl && f.source !== 'google-drive') URL.revokeObjectURL(f.previewUrl);
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
        waitForEncoding: false,
        alwaysRunAssembly: false,
      });

      this.uppy.use(GoogleDrivePicker, {
        companionUrl: COMPANION_URL,
        companionAllowedHosts: COMPANION_ALLOWED_HOSTS,
        clientId: environment.googleClientId,
        apiKey: environment.googleApiKey,
        appId: environment.googleAppId,
      });

      this.uppy.on('file-added', (uppyFile) => {
        if (uppyFile.source !== 'GoogleDrivePicker') return;

        const id = uppyFile.id;
        this.uppyManagedFileIds.add(id);
        const mimeType = uppyFile.type ?? '';
        const rawSize = uppyFile.size;
        const fullName = uppyFile.name ?? 'unknown';
        const ext = fullName.includes('.') ? fullName.split('.').pop()! : '';
        const baseName = getBaseName(fullName);
        const error = validateGDriveFile(mimeType, rawSize ?? 0, fullName);

        this.ngZone.run(() => {
          if (error) {
            this.validationErrors.update((errs) => [...errs, { ...error, fileId: id }]);
            this.uppy.removeFile(id);
            this.uppyManagedFileIds.delete(id);
            return;
          }
          if (this.selectedFiles().length >= 10) {
            this.validationErrors.update((errs) => [
              ...errs,
              {
                fileId: id,
                filename: fullName,
                type: 'file-too-large',
                message: 'Maximum 10 files allowed. Please remove some files to add more.',
              },
            ]);
            this.uppy.removeFile(id);
            this.uppyManagedFileIds.delete(id);
            return;
          }
          this.selectedFiles.update((files) => [
            ...files,
            {
              id,
              source: 'google-drive',
              remoteExt: ext,
              name: baseName,
              originalName: baseName,
              previewUrl: null,
              formattedSize: rawSize != null ? formatFileSize(rawSize) : 'Unknown',
              typeLabel: getMimeLabel(mimeType),
              progress: null,
              renamed: false,
            },
          ]);
          this.refreshDuplicates();
        });

        // Fetch thumbnail from Drive API v3
        const remoteBody = (
          uppyFile as unknown as { remote?: { body?: Record<string, string> } }
        ).remote?.body;
        const fileId = remoteBody?.['fileId'];
        const accessToken = remoteBody?.['accessToken'];
        if (fileId && accessToken) {
          fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
            .then((r) => r.json())
            .then((data: { thumbnailLink?: string }) => {
              const thumb = data.thumbnailLink?.replace(/=s\d+$/, '=s400');
              if (thumb) {
                this.ngZone.run(() => {
                  this.selectedFiles.update((files) =>
                    files.map((f) => (f.id === id ? { ...f, previewUrl: thumb } : f))
                  );
                });
              }
            })
            .catch(() => { /* thumbnail fetch failure is non-fatal */ });
        }
      });

      this.uppy.on('transloadit:assembly-created', (assembly) => {
        this.currentAssemblyUrl = (assembly as { assembly_ssl_url: string }).assembly_ssl_url;
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
          this.clearPolling();
          this.uploadStatus.set('error');
          console.error('Upload error:', error);
        });
      });

      this.uppy.on('complete', (result) => {
        if ((result.failed?.length ?? 0) > 0) return;
        const assemblyUrl = this.currentAssemblyUrl;
        if (assemblyUrl) {
          this.startPolling(assemblyUrl);
        }
      });
    });
  }

  // ── Tab Switching ────────────────────────────────────────────────────────
  switchTab(tab: 'local' | 'drive'): void {
    if (tab === this.uploadTab()) return;
    if (tab === 'drive') {
      this.uploadTab.set('drive');
      this.cdr.detectChanges();
      const plugin = this.uppy.getPlugin('GoogleDrivePicker');
      const el = this.gdriveMount?.nativeElement;
      if (plugin && el) {
        (plugin as unknown as { mount(el: HTMLElement, plugin: unknown): void }).mount(el, plugin);
      }
    } else {
      const plugin = this.uppy.getPlugin('GoogleDrivePicker');
      if (plugin) {
        try { (plugin as unknown as { unmount(): void }).unmount(); } catch { /* ignore */ }
      }
      this.uploadTab.set('local');
    }
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
    const maxFiles = 10;
    const currentFileCount = this.selectedFiles().length;
    const remainingSlots = Math.max(0, maxFiles - currentFileCount);

    if (remainingSlots === 0) {
      this.validationErrors.set([{
        fileId: '',
        filename: '',
        type: 'file-too-large',
        message: `Maximum ${maxFiles} files allowed. Please remove some files to add more.`
      }]);
      return;
    }

    const filesToProcess = files.slice(0, remainingSlots);
    const newErrors: ValidationError[] = [];
    const newUploadFiles: UploadFile[] = [];

    for (const file of filesToProcess) {
      const id = crypto.randomUUID();
      const error = validateFile(file);

      if (error) {
        newErrors.push({ ...error, fileId: id });
        continue;
      }

      newUploadFiles.push({
        id,
        source: 'local',
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
    if (file?.previewUrl && file.source !== 'google-drive') URL.revokeObjectURL(file.previewUrl);
    if (this.uppyManagedFileIds.has(fileId)) {
      this.uppy.removeFile(fileId);
      this.uppyManagedFileIds.delete(fileId);
    }
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

    setTimeout(() => {
      this.renamePanel?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = this.renamePanel?.nativeElement.querySelector('.content-upload__rename-input') as HTMLInputElement;
      input?.focus();
    }, 0);
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

  toggleSuggestionDetails(): void {
    this.showSuggestionDetails.update((v) => !v);
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

  // ── Assembly Polling ─────────────────────────────────────────────────────
  private startPolling(assemblyUrl: string): void {
    this.clearPolling();
    this.pollInterval = setInterval(() => {
      fetch(assemblyUrl)
        .then((res) => res.json())
        .then((data: { ok: string; error?: string }) => {
          if (data.ok === 'ASSEMBLY_COMPLETED' || data.ok === 'ASSEMBLY_COMPLETE') {
            this.clearPolling();
            this.ngZone.run(() => {
              this.uploadStatus.set('complete');
              this.showSuccessModal.set(true);
              this.onUpload.emit({ status: 'uploaded', data: data as TransloaditAssembly });
            });
          } else if (data.error || data.ok === 'REQUEST_ABORTED' || data.ok === 'ASSEMBLY_ABORTED') {
            this.clearPolling();
            this.ngZone.run(() => {
              this.uploadStatus.set('error');
              console.error('Assembly error:', data);
            });
          }
        })
        .catch((err: unknown) => {
          console.error('Assembly poll error:', err);
        });
    }, 1500);
  }

  private clearPolling(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  startUpload(): void {
    if (this.isUploadDisabled()) return;

    this.uploadStatus.set('uploading');
    this.onUpload.emit({ status: 'uploading', data: null });
    this.currentAssemblyUrl = null;
    this.clearPolling();

    // Remove only non-GDrive files already in Uppy's queue
    for (const uppyFile of this.uppy.getFiles()) {
      if (!this.uppyManagedFileIds.has(uppyFile.id)) {
        this.uppy.removeFile(uppyFile.id);
      }
    }

    // Add local files to Uppy
    for (const uploadFile of this.selectedFiles()) {
      if (this.uppyManagedFileIds.has(uploadFile.id)) continue;
      const localFile = uploadFile.file;
      if (!localFile) continue;
      const ext = localFile.name.split('.').pop();
      this.uppy.addFile({
        id: uploadFile.id,
        name: uploadFile.name + '.' + ext,
        type: localFile.type,
        data: localFile,
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
    this.currentAssemblyUrl = null;
    this.uppyManagedFileIds.clear();
  }

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
  }
}
