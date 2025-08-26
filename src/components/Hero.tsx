// components/Hero.tsx
import React from 'react';
import { Github } from 'lucide-react'; // We ignore this for now, Since this is a hackathon project

const Hero: React.FC = () => {
  return (
    <header className="text-center space-y-4">
      <h1 className="text-4xl sm:text-5xl font-extrabold text-white leading-tight">
        Agentic AI-Powered CI/CD Manager
      </h1>
      <p className="text-lg text-gray-400 max-w-2xl mx-auto">
        Automate and optimize your software development lifecycle with an intelligent agent
        that analyzes build failures and suggests fixes.
      </p>
      <div className="flex justify-center pt-4">
        <a 
          href="https://github.com/new" 
          target="_blank" 
          rel="noopener noreferrer"
          className="inline-flex items-center px-8 py-3 bg-blue-600 text-white text-lg font-semibold rounded-full shadow-lg hover:bg-blue-700 transition-all duration-300 transform hover:scale-105"
        >
          <Github className="w-6 h-6 mr-3" />
          Get Started on GitHub
        </a>
      </div>
    </header>
  );
};

export default Hero;