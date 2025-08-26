// components/FeatureCard.tsx
import React, { ReactNode } from 'react';

interface FeatureCardProps {
  icon: ReactNode;
  title: string;
  description: string;
}

const FeatureCard: React.FC<FeatureCardProps> = ({ icon, title, description }) => {
  return (
    <div className="bg-gray-700 p-6 rounded-lg shadow-xl border-t-4 border-blue-500 transform hover:translate-y-[-5px] transition-all duration-300">
      <div className="flex items-center mb-4">
        <div className="bg-blue-500 p-3 rounded-full">
          {icon}
        </div>
        <h3 className="text-xl font-bold ml-4 text-white">{title}</h3>
      </div>
      <p className="text-gray-400">{description}</p>
    </div>
  );
};

export default FeatureCard;