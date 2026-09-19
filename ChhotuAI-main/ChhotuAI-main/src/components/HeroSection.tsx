import React from 'react';
import { motion } from 'framer-motion';
import { Play, Users } from 'lucide-react';

const HeroSection: React.FC = () => {
  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <section className="relative h-screen flex flex-col overflow-hidden">
      {/* Background Image */}
      <div className="absolute inset-0">
        <img
          src="/bg.jpeg"
          alt="Background"
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-black/50"></div>
      </div>

      {/* Top Navbar */}
      <motion.nav 
        className="relative z-10 flex justify-between items-center px-6 lg:px-12 py-6"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
      >
        {/* Brand Name - Left */}
        <div className="font-serif text-2xl lg:text-3xl font-bold text-white tracking-wide">
          Chotu.AI
        </div>
        
        {/* Navigation - Center */}
        <div className="hidden md:flex items-center space-x-8 lg:space-x-12">
          <a href="#features" className="font-sans text-white/90 hover:text-white transition-colors text-sm lg:text-base tracking-wide">
            Features
          </a>
          <a href="#how-it-works" className="font-sans text-white/90 hover:text-white transition-colors text-sm lg:text-base tracking-wide">
            How It Works
          </a>
          <a href="#about" className="font-sans text-white/90 hover:text-white transition-colors text-sm lg:text-base tracking-wide">
            About
          </a>
          <a href="#contact" className="font-sans text-white/90 hover:text-white transition-colors text-sm lg:text-base tracking-wide">
            Contact
          </a>
        </div>
        
        {/* Try Demo Button - Right */}
        <button
          onClick={() => scrollToSection('newsletter')}
          className="px-4 py-2 lg:px-6 lg:py-3 bg-transparent border border-white/80 text-white font-sans text-sm lg:text-base tracking-wide hover:bg-white hover:text-black transition-all duration-300 rounded-sm"
        >
          Try Demo
        </button>
      </motion.nav>

      {/* Main Content */}
      <div className="relative z-10 flex-1 flex items-center">
        <div className="w-full max-w-7xl mx-auto px-6 lg:px-12">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
            {/* Left Column - Main Headlines */}
            <div className="space-y-6 lg:space-y-8">
              <motion.h1 
                className="font-serif text-4xl sm:text-5xl lg:text-6xl xl:text-7xl font-bold text-white leading-tight tracking-wide"
                initial={{ opacity: 0, y: 50 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.3 }}
              >
                Smart WhatsApp Bot<br />
                For Indian Shopkeepers
              </motion.h1>
              
              <motion.p 
                className="font-sans text-lg lg:text-xl xl:text-2xl text-white/90 leading-relaxed"
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.6 }}
              >
                Track inventory, connect with NGOs, and manage your shop in 126+ languages.
              </motion.p>

              <motion.p 
                className="font-sans text-sm lg:text-base text-white/80 leading-relaxed max-w-lg"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1, delay: 0.9 }}
              >
                Powered by VAPI voice agents & Make.com AI workflows. Zero waste, maximum profit.
              </motion.p>
            </div>

            {/* Right Column - Description */}
            <motion.div 
              className="space-y-8"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 1, delay: 1.2 }}
            >
              <p className="font-sans text-base lg:text-lg text-white/90 leading-relaxed">
                Empower your shop with AI that understands your business. From inventory tracking to donation coordination, Chotu.AI helps Indian shopkeepers reduce waste, increase profits, and serve their community better - all through simple WhatsApp conversations in your preferred language.
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 pt-4">
                <button
                  onClick={() => scrollToSection('newsletter')}
                  className="px-8 py-3 bg-white text-black font-sans font-medium text-sm lg:text-base tracking-wide hover:bg-white/90 transition-all duration-300"
                >
                  Start Using Chotu.AI
                </button>
                
                <button
                  onClick={() => scrollToSection('live-users')}
                  className="px-8 py-3 bg-transparent border border-white/60 text-white font-sans font-medium text-sm lg:text-base tracking-wide hover:border-white hover:bg-white/10 transition-all duration-300 flex items-center gap-2 justify-center"
                >
                  <Users size={16} />
                  See Live Users
                </button>
                
                <button
                  onClick={() => window.open('https://drive.google.com/file/d/12AYQyTab_ofnYW6Deer0p7FS2G3VkK2V/view?usp=drive_link', '_blank')}
                  className="px-8 py-3 bg-transparent border border-white/60 text-white font-sans font-medium text-sm lg:text-base tracking-wide hover:border-white hover:bg-white/10 transition-all duration-300 flex items-center gap-2 justify-center"
                >
                  <Play size={16} />
                  Watch Demo
                </button>
              </div>
            </motion.div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
