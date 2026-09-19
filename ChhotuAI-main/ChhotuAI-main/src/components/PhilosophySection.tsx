import React from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';

const PhilosophySection: React.FC = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section id="about" ref={ref} className="py-32 px-4 bg-void-black">
      <div className="max-w-6xl mx-auto text-center">
        <motion.h2 
          className="font-serif text-5xl md:text-6xl lg:text-7xl font-bold text-white mb-16 tracking-wide"
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 1 }}
        >
          Our Mission
        </motion.h2>
        
        <motion.div 
          className="max-w-4xl mx-auto space-y-12"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 1, delay: 0.3 }}
        >
          <p className="font-serif text-2xl md:text-3xl lg:text-4xl text-gray-300 leading-relaxed">
            We believe technology should empower every shopkeeper, no matter how small their business.
          </p>
          
          <p className="font-serif text-2xl md:text-3xl lg:text-4xl text-gray-300 leading-relaxed">
            Chotu.AI bridges the gap between traditional Indian shops and modern AI, creating a sustainable ecosystem where nothing goes to waste.
          </p>
          
          <p className="font-serif text-2xl md:text-3xl lg:text-4xl text-gray-300 leading-relaxed">
            From voice commands in local languages to automated donation coordination — we're building the future of retail for Bharat.
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default PhilosophySection;
