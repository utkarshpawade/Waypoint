import React from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';

const FeaturedCollection: React.FC = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  const products = [
    {
      id: 1,
      name: "Smart Inventory Tracking",
      description: "Voice commands in 126+ languages to update stock",
      price: "Free",
      image: "https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=600&h=600&fit=crop&crop=center"
    },
    {
      id: 2,
      name: "Excel Integration",
      description: "Automatic updates to your existing spreadsheets",
      price: "Included",
      image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&h=600&fit=crop&crop=center"
    },
    {
      id: 3,
      name: "NGO Connection",
      description: "Find nearby donation centers for expiring goods",
      price: "Community",
      image: "https://images.unsplash.com/photo-1559027615-cd4628902d4a?w=600&h=600&fit=crop&crop=center"
    },
    {
      id: 4,
      name: "Maps Integration",
      description: "Google Maps API for location-based services",
      price: "Smart",
      image: "https://images.unsplash.com/photo-1569025743873-ea3a9ade89f9?w=600&h=600&fit=crop&crop=center"
    }
  ];

  return (
    <section id="features" ref={ref} className="py-32 px-4 bg-void-black">
      <div className="max-w-7xl mx-auto">
        <motion.h2 
          className="font-serif text-5xl md:text-6xl text-white text-center mb-20 tracking-wide"
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 1 }}
        >
          Key Features
        </motion.h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {products.map((product, index) => (
            <motion.div
              key={product.id}
              className="group relative bg-gradient-to-br from-cosmic-blue/20 to-transparent border border-nova-silver/30 rounded-lg overflow-hidden hover:border-white/50 transition-all duration-500 hover:shadow-2xl hover:shadow-white/10"
              initial={{ opacity: 0, y: 50 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
              transition={{ duration: 0.8, delay: index * 0.2 }}
            >
              <div className="aspect-square overflow-hidden">
                <img 
                  src={product.image} 
                  alt={product.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                />
              </div>
              
              <div className="p-6">
                <h3 className="font-serif text-xl text-white mb-2">{product.name}</h3>
                <p className="font-sans text-gray-400 text-sm mb-4">{product.description}</p>
                <div className="flex justify-between items-center">
                  <span className="font-sans text-lg text-nova-silver font-medium">{product.price}</span>
                  <button className="px-4 py-2 border border-nova-silver text-nova-silver text-sm hover:border-white hover:text-white transition-all duration-300">
                    Learn More
                  </button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturedCollection;
