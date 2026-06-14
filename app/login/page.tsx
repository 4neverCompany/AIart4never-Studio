'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Loader2, Lock, User, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Mock login logic - in a real app, this would call an API
    setTimeout(() => {
      if (username === 'admin' && password === 'admin') {
        // Store auth state in localStorage or a cookie
        localStorage.setItem('mashup_auth', 'true');
        router.push('/app');
      } else {
        setError('Invalid username or password. (Hint: admin/admin)');
        setIsLoading(false);
      }
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background orbs */}
      <motion.div 
        animate={{ 
          x: [0, 50, 0], 
          y: [0, 100, 0] 
        }}
        transition={{ duration: 15, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#00e6ff]/6 rounded-full blur-[120px] -z-10" 
      />
      <motion.div 
        animate={{ 
          x: [0, -50, 0], 
          y: [0, -100, 0] 
        }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#c5a062]/5 rounded-full blur-[120px] -z-10" 
      />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#00e6ff]/12 border border-[#00e6ff]/30 mb-4 shadow-[0_0_32px_rgba(0,230,255,0.15)]">
            <Sparkles className="w-8 h-8 text-[#00e6ff]" />
          </div>
          <h1 className="type-display text-3xl tracking-tight">Welcome Back</h1>
          <p className="type-muted mt-2">Log in to MashupForge</p>
        </div>

        <div className="card p-8 shadow-2xl">
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest ml-1">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  className="input-brand w-full pl-10 pr-4 py-3"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest ml-1">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="input-brand w-full pl-10 pr-4 py-3"
                  required
                />
              </div>
            </div>

            {error && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2"
              >
                <Lock className="w-3 h-3" />
                {error}
              </motion.div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="btn-cta uppercase tracking-widest py-4"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Authenticating...
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  Enter Studio
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-[#c5a062]/15 text-center">
            <p className="type-caption text-zinc-600">
              Demo access only. Default: <span className="text-[#00e6ff]/70 font-mono">admin / admin</span>
            </p>
          </div>
        </div>

        <div className="mt-8 text-center">
          <button 
            onClick={() => router.push('/')}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← Back to Home
          </button>
        </div>
      </motion.div>
    </div>
  );
}
