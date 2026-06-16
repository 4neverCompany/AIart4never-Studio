import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { AgentMarkdown } from '@/components/agent/AgentConsole';

// THINK-LEAK / MARKDOWN FIX: the agent (a reasoning model) replies in markdown.
// Rendered raw, the syntax chars (##, **, -, `) leak into the chat bubble.
// AgentMarkdown must turn them into real themed elements.

describe('AgentMarkdown', () => {
  it('renders **bold** as <strong>, not raw asterisks', () => {
    const { container } = render(<AgentMarkdown text={'forge the **Iron Halo** beat'} />);
    expect(container.querySelector('strong')?.textContent).toBe('Iron Halo');
    expect(container.textContent).not.toContain('**');
  });

  it('renders a ## heading as a heading element, not raw hashes', () => {
    const { container } = render(<AgentMarkdown text={'## Variant Reveal'} />);
    const heading = container.querySelector('h3, h4, h5');
    expect(heading?.textContent).toBe('Variant Reveal');
    expect(container.textContent).not.toContain('##');
  });

  it('renders a bulleted list as <li> items', () => {
    const { container } = render(<AgentMarkdown text={'- Confrontation\n- Temptation\n- Tragedy'} />);
    expect(container.querySelectorAll('li')).toHaveLength(3);
  });

  it('renders inline `code` as a <code> element', () => {
    const { container } = render(<AgentMarkdown text={'call `generate_image` next'} />);
    expect(container.querySelector('code')?.textContent).toBe('generate_image');
  });

  it('renders partial/streaming markdown gracefully (no throw)', () => {
    expect(() => render(<AgentMarkdown text={'building a draft **bol'} />)).not.toThrow();
  });
});
