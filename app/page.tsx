import { Nav } from '@/components/landing/Nav';
import { Hero } from '@/components/landing/Hero';
import { Stats } from '@/components/landing/Stats';
import { Features } from '@/components/landing/Features';
import { Pipeline } from '@/components/landing/Pipeline';
import { TechStack } from '@/components/landing/TechStack';
import { CTA } from '@/components/landing/CTA';
import { Footer } from '@/components/landing/Footer';

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#050505] text-white">
      <Nav />
      <Hero ctaHref="/studio" />
      <Stats />
      <Features />
      <Pipeline />
      <TechStack />
      <CTA />
      <Footer />
    </main>
  );
}
