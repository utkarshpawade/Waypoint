import React from 'react';
import { motion } from 'framer-motion';
import { Instagram, Twitter, Facebook, Mail, Phone, MapPin } from 'lucide-react';

const Footer: React.FC = () => {
  return (
    <footer id="contact" className="py-16 px-4 bg-void-black border-t border-nova-silver/20">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12">
          <motion.div
            className="text-center md:text-left"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h3 className="font-serif text-3xl text-white mb-4">Chotu.AI</h3>
            <p className="font-sans text-gray-400 text-sm leading-relaxed">
              Empowering Indian shopkeepers with AI technology. WhatsApp-based inventory management and community donation platform for a sustainable future.
            </p>
          </motion.div>
          
          <motion.div
            className="text-center md:text-left"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1 }}
          >
            <h4 className="font-sans text-white text-lg mb-4">Navigation</h4>
            <ul className="space-y-2 text-gray-400 font-sans text-sm">
              <li><a href="#features" className="hover:text-white transition-colors">Features</a></li>
              <li><a href="#about" className="hover:text-white transition-colors">About</a></li>
              <li><a href="#how-it-works" className="hover:text-white transition-colors">How It Works</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Try Demo</a></li>
            </ul>
          </motion.div>
          
          <motion.div
            className="text-center md:text-left"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <h4 className="font-sans text-white text-lg mb-4">Contact</h4>
            <ul className="space-y-2 text-gray-400 font-sans text-sm">
              <li className="flex items-center justify-center md:justify-start gap-2">
                <Mail size={16} />
                <span>contact@chotu.ai</span>
              </li>
              <li className="flex items-center justify-center md:justify-start gap-2">
                <Phone size={16} />
                <span>+91 98765 43210</span>
              </li>
              <li className="flex items-center justify-center md:justify-start gap-2">
                <MapPin size={16} />
                <span>Mumbai, India</span>
              </li>
            </ul>
          </motion.div>
          
          <motion.div
            className="text-center md:text-left"
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            <h4 className="font-sans text-white text-lg mb-4">Follow the Cosmos</h4>
            <div className="flex justify-center md:justify-start gap-4">
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <Instagram size={20} />
              </a>
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <Twitter size={20} />
              </a>
              <a href="#" className="text-gray-400 hover:text-white transition-colors">
                <Facebook size={20} />
              </a>
            </div>
          </motion.div>
        </div>
        
        <div className="border-t border-nova-silver/20 mt-12 pt-8 text-center">
          <p className="font-sans text-gray-400 text-sm">
            © 2025 NoirNova. All rights reserved. Crafted with cosmic precision.
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
