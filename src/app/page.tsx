// app/page.tsx
import Hero from '@/components/Hero';
import Features from '@/components/Features';

export default function Home() {
  return (
    <main className="bg-gray-900 text-gray-200 min-h-screen font-sans flex flex-col items-center justify-center p-4">
      <div className="max-w-4xl w-full mx-auto p-8 sm:p-12 bg-gray-800 rounded-2xl shadow-2xl space-y-12">
        <Hero />
        <Features />
      </div>
    </main>
  );
}