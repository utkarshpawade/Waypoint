import React from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';

const MaterialsSection: React.FC = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });

  return (
    <section id="how-it-works" ref={ref} className="py-32 px-4 bg-void-black">
      <div className="max-w-7xl mx-auto">
        <motion.h2 
          className="font-serif text-5xl md:text-6xl text-white text-center mb-20 tracking-wide"
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 1 }}
        >
          How It Works
        </motion.h2>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          <motion.div
            className="space-y-8"
            initial={{ opacity: 0, x: -50 }}
            animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: -50 }}
            transition={{ duration: 1, delay: 0.3 }}
          >
            <div className="border-l-2 border-nova-silver pl-6">
              <h3 className="font-serif text-2xl text-white mb-3">Voice Commands</h3>
              <p className="font-sans text-gray-400 leading-relaxed">
                Simply speak to Chotu.AI in your preferred language. Update inventory, check stock levels, or add new items - all through natural conversation on WhatsApp.
              </p>
            </div>
            
            <div className="border-l-2 border-nova-silver pl-6">
              <h3 className="font-serif text-2xl text-white mb-3">Excel Integration</h3>
              <p className="font-sans text-gray-400 leading-relaxed">
                Python scripts automatically update your existing Excel sheets. See real-time changes and maintain your familiar workflow while leveraging AI power.
              </p>
            </div>
            
            <div className="border-l-2 border-nova-silver pl-6">
              <h3 className="font-serif text-2xl text-white mb-3">Smart Donations</h3>
              <p className="font-sans text-gray-400 leading-relaxed">
                Google Maps API finds nearby NGOs and donation centers. Automatically coordinate donations of items nearing expiry to reduce waste and help your community.
              </p>
            </div>
          </motion.div>
          
          <motion.div
            className="relative"
            initial={{ opacity: 0, x: 50 }}
            animate={isInView ? { opacity: 1, x: 0 } : { opacity: 0, x: 50 }}
            transition={{ duration: 1, delay: 0.6 }}
          >
            <div className="aspect-square rounded-lg overflow-hidden border border-nova-silver/30">
              <img 
                src="https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=600&h=600&fit=crop&crop=center"
                alt="WhatsApp AI Bot"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute inset-0 bg-gradient-to-br from-cosmic-blue/20 to-transparent rounded-lg"></div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default MaterialsSection;
