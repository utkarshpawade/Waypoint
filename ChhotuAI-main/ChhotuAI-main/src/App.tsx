import React from 'react';
import HeroSection from './components/HeroSection';
import PhilosophySection from './components/PhilosophySection';
import FeaturedCollection from './components/FeaturedCollection';
import MaterialsSection from './components/MaterialsSection';
import TestimonialsSection from './components/TestimonialsSection';
import LiveUsersSection from './components/LiveUsersSection';
import NewsletterSection from './components/NewsletterSection';
import Footer from './components/Footer';

function App() {
  return (
    <div className="bg-void-black min-h-screen">
      <HeroSection />
      <PhilosophySection />
      <FeaturedCollection />
      <MaterialsSection />
      <TestimonialsSection />
      <LiveUsersSection />
      <NewsletterSection />
      <Footer />
    </div>
  );
}

export default App;
