import {
  Lightbulb,
  TrendingUp,
  Sparkles,
  Image as ImageIcon,
  Tag,
  Edit3,
  Calendar,
} from 'lucide-react';

export type PipelineToggleKey =
  | 'pipelineAutoTag'
  | 'pipelineAutoCaption'
  | 'pipelineAutoSchedule';

export type Stage = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  matchStep?: string;
  toggleKey?: PipelineToggleKey;
  /** Tailwind bg class for the status dot (active ping + completed fill). */
  dotColor: string;
};

export const STAGES: Stage[] = [
  { key: 'idea',     label: 'Idea',     icon: Lightbulb,  matchStep: 'Updating status',      dotColor: 'bg-amber-500' },
  { key: 'trending', label: 'Trending', icon: TrendingUp,  matchStep: 'Researching trending', dotColor: 'bg-[#00e6ff]' },
  { key: 'prompt',   label: 'Prompt',   icon: Sparkles,    matchStep: 'Expanding idea',        dotColor: 'bg-purple-500' },
  { key: 'image',    label: 'Image',    icon: ImageIcon,   matchStep: 'Generating',            dotColor: 'bg-emerald-500' },
  { key: 'tag',      label: 'Tag',      icon: Tag,         matchStep: 'Tagging',   toggleKey: 'pipelineAutoTag',      dotColor: 'bg-sky-400' },
  { key: 'caption',  label: 'Caption',  icon: Edit3,       matchStep: 'Captioning', toggleKey: 'pipelineAutoCaption', dotColor: 'bg-violet-400' },
  { key: 'schedule', label: 'Schedule', icon: Calendar,    matchStep: 'Scheduling', toggleKey: 'pipelineAutoSchedule', dotColor: 'bg-amber-400' },
];
