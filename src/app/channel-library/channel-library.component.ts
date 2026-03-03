import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ContentUploadComponent } from '../content-upload/content-upload.component';
import type {
  LibraryItem,
  OnUploadPayload,
  TransloaditAssembly,
} from '../content-upload/content-upload.types';
import { formatFileSize, getMimeLabel } from '../content-upload/content-upload.utils';

export function isVideoType(typeLabel: string): boolean {
  return typeLabel === 'MP4' || typeLabel === 'WEBM';
}

@Component({
  selector: 'app-channel-library',
  standalone: true,
  imports: [ContentUploadComponent, FormsModule, DatePipe],
  templateUrl: './channel-library.component.html',
  styleUrl: './channel-library.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelLibraryComponent implements OnDestroy {
  // ── Library State ─────────────────────────────────────────────────────────
  readonly libraryItems = signal<LibraryItem[]>([]);
  readonly showUploadModal = signal(false);
  readonly isUploading = signal(false);
  readonly newItemIds = signal<Set<string>>(new Set());

  // ── View & Filter State ───────────────────────────────────────────────────
  readonly viewMode = signal<'grid' | 'list'>('grid');
  readonly searchQuery = signal('');
  readonly displayLimit = signal(36);

  // ── Bulk Select State ─────────────────────────────────────────────────────
  readonly bulkSelectActive = signal(false);
  readonly selectedIds = signal<Set<string>>(new Set());

  private newItemTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Computed ──────────────────────────────────────────────────────────────
  readonly libraryNames = computed(() => this.libraryItems().map((i) => i.name));
  readonly totalCount = computed(() => this.libraryItems().length);

  readonly videoCount = computed(
    () => this.libraryItems().filter((i) => isVideoType(i.typeLabel)).length
  );

  readonly imageCount = computed(
    () => this.libraryItems().filter((i) => !isVideoType(i.typeLabel)).length
  );

  private readonly weekMs = 7 * 24 * 60 * 60 * 1000;

  readonly thisWeekCount = computed(() => {
    const cutoff = Date.now() - this.weekMs;
    return this.libraryItems().filter((i) => i.uploadedAt.getTime() >= cutoff).length;
  });

  readonly lastWeekCount = computed(() => {
    const now = Date.now();
    return this.libraryItems().filter((i) => {
      const t = i.uploadedAt.getTime();
      return t >= now - 2 * this.weekMs && t < now - this.weekMs;
    }).length;
  });

  readonly thisWeekDelta = computed(() => {
    const last = this.lastWeekCount();
    const curr = this.thisWeekCount();
    if (last === 0) return curr > 0 ? null : null;
    return ((curr - last) / last) * 100;
  });

  readonly filteredItems = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return this.libraryItems();
    return this.libraryItems().filter((i) => i.name.toLowerCase().includes(q));
  });

  readonly paginatedItems = computed(() =>
    this.filteredItems().slice(0, this.displayLimit())
  );

  readonly hasMore = computed(
    () => this.filteredItems().length > this.displayLimit()
  );


  // ── Modal ─────────────────────────────────────────────────────────────────
  openModal(): void {
    this.showUploadModal.set(true);
  }

  closeModal(): void {
    this.showUploadModal.set(false);
  }

  // ── Upload Handling ───────────────────────────────────────────────────────
  handleUpload(payload: OnUploadPayload): void {
    if (payload.status === 'uploading') {
      this.isUploading.set(true);
      return;
    }

    if (payload.status === 'uploaded' && payload.data) {
      this.isUploading.set(false);

      const newItems = this.buildLibraryItems(payload.data);
      const ids = new Set(newItems.map((i) => i.id));

      this.libraryItems.update((existing) => [...newItems, ...existing]);
      this.newItemIds.set(ids);
      this.displayLimit.set(Math.max(36, this.displayLimit()));

      if (this.newItemTimer) clearTimeout(this.newItemTimer);
      this.newItemTimer = setTimeout(() => this.newItemIds.set(new Set()), 1400);
    }
  }

  // ── View ──────────────────────────────────────────────────────────────────
  setViewMode(mode: 'grid' | 'list'): void {
    this.viewMode.set(mode);
  }

  showMore(): void {
    this.displayLimit.update((n) => n + 36);
  }

  // ── Bulk Select ───────────────────────────────────────────────────────────
  toggleBulkSelect(): void {
    this.bulkSelectActive.update((v) => !v);
    if (!this.bulkSelectActive()) this.selectedIds.set(new Set());
  }

  toggleItemSelect(id: string): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  bulkDelete(): void {
    const ids = this.selectedIds();
    this.libraryItems.update((items) => items.filter((i) => !ids.has(i.id)));
    this.selectedIds.set(new Set());
    this.bulkSelectActive.set(false);
  }

  // ── Template Helpers ─────────────────────────────────────────────────────
  isNewItem(id: string): boolean {
    return this.newItemIds().has(id);
  }

  isVideo(typeLabel: string): boolean {
    return isVideoType(typeLabel);
  }

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  onVideoEnter(event: MouseEvent): void {
    (event.currentTarget as HTMLVideoElement).play().catch(() => {});
  }

  onVideoLeave(event: MouseEvent): void {
    const video = event.currentTarget as HTMLVideoElement;
    video.pause();
    video.currentTime = 0;
  }

  onCardClick(id: string): void {
    if (this.bulkSelectActive()) this.toggleItemSelect(id);
  }

  formatDelta(delta: number | null): string {
    if (delta === null) return '—';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`;
  }

  // ── Library Builder ───────────────────────────────────────────────────────
  private buildLibraryItems(assembly: TransloaditAssembly): LibraryItem[] {
    const items: LibraryItem[] = [];
    for (const result of Object.values(assembly.results).flat()) {
      items.push({
        id: result.id,
        name: result.basename,
        typeLabel: getMimeLabel(result.mime),
        thumbnailUrl: result.ssl_url,
        formattedSize: formatFileSize(result.size),
        uploadedAt: new Date(),
        url: result.ssl_url,
      });
    }
    return items;
  }

  ngOnDestroy(): void {
    if (this.newItemTimer) clearTimeout(this.newItemTimer);
  }
}
