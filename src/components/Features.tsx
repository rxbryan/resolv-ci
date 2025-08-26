// components/Features.tsx
import React from 'react';
import { GitPullRequest, CheckCircle, Zap } from 'lucide-react';
import FeatureCard from './FeatureCard';

const Features: React.FC = () => {
  return (
    <section className="space-y-6">
      <h2 className="text-3xl font-bold text-white text-center">Core Features</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <FeatureCard 
          icon={<GitPullRequest className="text-white w-6 h-6" />}
          title="Automated Analysis"
          description="Automatically analyze CI/CD pipeline logs to pinpoint the root cause of build failures."
        />
        <FeatureCard 
          icon={<CheckCircle className="text-white w-6 h-6" />}
          title="Intelligent Suggestions"
          description="Receive proactive, AI-generated code suggestions and pull request comments to resolve issues."
        />
        <FeatureCard 
          icon={<Zap className="text-white w-6 h-6" />}
          title="Real-time Insights"
          description="Leverage TiDB to gain real-time, scalable insights from your historical build data."
        />
      </div>
    </section>
  );
};

export default Features;