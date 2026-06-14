import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { createRef } from 'react';
import { AutoTextarea } from '@/components/AutoTextarea';

/**
 * v1.9.1 regression: AutoTextarea is a forwardRef component used both WITH a
 * ref (Post Ready) and WITHOUT one (the Captioning Studio cards). Its
 * useLayoutEffect previously did `(ref as React.RefObject).current`, which
 * threw "Cannot read properties of null (reading 'current')" whenever the
 * forwarded ref was null (no ref) or a callback ref — crashing MainContent
 * (caught by its error boundary) once there were captioned images to render.
 */
describe('AutoTextarea ref safety', () => {
  it('renders WITHOUT a forwarded ref without throwing', () => {
    expect(() =>
      render(<AutoTextarea value="hello" onChange={() => {}} />),
    ).not.toThrow();
  });

  it('still forwards an object ref to the underlying textarea', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<AutoTextarea ref={ref} value="hello" onChange={() => {}} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current?.value).toBe('hello');
  });

  it('supports a callback ref', () => {
    let node: HTMLTextAreaElement | null = null;
    render(
      <AutoTextarea
        ref={(n) => {
          node = n;
        }}
        value="hi"
        onChange={() => {}}
      />,
    );
    expect(node).toBeInstanceOf(HTMLTextAreaElement);
  });
});
