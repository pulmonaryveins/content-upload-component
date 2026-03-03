import { Component } from '@angular/core';
import { ContentUploadComponent } from './content-upload/content-upload.component';
import type { OnUploadPayload } from './content-upload/content-upload.types';

@Component({
  selector: 'app-root',
  imports: [ContentUploadComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  handleUpload(payload: OnUploadPayload): void {
    console.log('Upload event:', payload.status, payload.data);
  }
}
