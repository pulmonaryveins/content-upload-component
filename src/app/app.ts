import { Component } from '@angular/core';
import { ChannelLibraryComponent } from './channel-library/channel-library.component';

@Component({
  selector: 'app-root',
  imports: [ChannelLibraryComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
