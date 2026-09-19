import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useInView } from 'framer-motion';
import { useRef } from 'react';

const NewsletterSection: React.FC = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    gmail: ''
  });
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.name && formData.phone && formData.gmail) {
      try {
        // Send data to webhook
        const response = await fetch('https://hook.us2.make.com/epej0fvpdlba3uck275gsfpj4pkertbm', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(formData),
        });

        if (response.ok) {
          setIsSubmitted(true);
          setFormData({ name: '', phone: '', gmail: '' });
          setTimeout(() => setIsSubmitted(false), 5000);
        }
      } catch (error) {
        console.error('Error submitting form:', error);
        // Still show success message to user even if webhook fails
        setIsSubmitted(true);
        setFormData({ name: '', phone: '', gmail: '' });
        setTimeout(() => setIsSubmitted(false), 5000);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  return (
    <section id="newsletter" ref={ref} className="py-32 px-4 bg-void-black">
      <div className="max-w-4xl mx-auto text-center">
        <motion.h2 
          className="font-serif text-5xl md:text-6xl text-white mb-8 tracking-wide"
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 1 }}
        >
          Join the AI Revolution
        </motion.h2>
        
        <motion.p 
          className="font-sans text-xl text-gray-400 mb-12 max-w-2xl mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 1, delay: 0.3 }}
        >
          Get early access to Chotu.AI and be among the first shopkeepers to transform their business with AI.
        </motion.p>
        
        <motion.form 
          onSubmit={handleSubmit}
          className="flex flex-col gap-6 justify-center items-center max-w-md mx-auto"
          initial={{ opacity: 0, y: 30 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 1, delay: 0.6 }}
        >
          <input
            type="text"
            name="name"
            value={formData.name}
            onChange={handleInputChange}
            placeholder="Enter your name"
            className="w-full px-6 py-3 bg-transparent border border-nova-silver text-white placeholder-gray-500 focus:border-white focus:outline-none transition-colors duration-300"
            required
          />
          
          <input
            type="tel"
            name="phone"
            value={formData.phone}
            onChange={handleInputChange}
            placeholder="Enter your phone number"
            className="w-full px-6 py-3 bg-transparent border border-nova-silver text-white placeholder-gray-500 focus:border-white focus:outline-none transition-colors duration-300"
            required
          />
          
          <input
            type="email"
            name="gmail"
            value={formData.gmail}
            onChange={handleInputChange}
            placeholder="Enter your Gmail"
            className="w-full px-6 py-3 bg-transparent border border-nova-silver text-white placeholder-gray-500 focus:border-white focus:outline-none transition-colors duration-300"
            required
          />
          
          <button
            type="submit"
            className="w-full px-8 py-3 bg-transparent border border-white text-white hover:bg-white hover:text-black transition-all duration-300 font-medium tracking-wide"
          >
            {isSubmitted ? 'You\'ll receive a message from chhotu ai within the next 24 hours.' : 'Get Early Access'}
          </button>
        </motion.form>
      </div>
    </section>
  );
};

export default NewsletterSection;
