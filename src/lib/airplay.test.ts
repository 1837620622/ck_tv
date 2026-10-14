import { airPlayPicker } from './airplay';

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
};

describe('airPlayPicker', () => {
  it('reports no-video before the player has rendered', () => {
    expect(airPlayPicker(null)).toBe('no-video');
  });

  it('reports unsupported where the AirPlay picker is missing', () => {
    expect(airPlayPicker(document.createElement('video'))).toBe('unsupported');
  });

  it('opens the picker on the playing video', () => {
    const video = document.createElement('video') as AirPlayVideo;
    const picker = jest.fn();
    video.webkitShowPlaybackTargetPicker = picker;
    expect(airPlayPicker(video)).toBe('shown');
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.instances[0]).toBe(video);
  });

  it('reports unsupported when the browser refuses to open the picker', () => {
    const video = document.createElement('video') as AirPlayVideo;
    video.webkitShowPlaybackTargetPicker = jest.fn(() => {
      throw new Error('NotAllowedError');
    });
    expect(airPlayPicker(video)).toBe('unsupported');
  });
});
