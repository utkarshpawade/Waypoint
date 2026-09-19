import React, { useState, useEffect, useRef } from 'react';
import { motion, useInView } from 'framer-motion';
import { Users, MessageCircle, Phone, TrendingUp } from 'lucide-react';

const LiveUsersSection: React.FC = () => {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.3 });
  const [webhookTriggered, setWebhookTriggered] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [webhookData, setWebhookData] = useState({
    liveUsers: 0,
    userRequests: 0
  });

  // Dummy data for live users (keeping some as dummy)
  const liveUsersData = {
    totalMessages: 45678,
    languagesUsed: 23
  };

  // Trigger webhook when section comes into view
  useEffect(() => {
    if (isInView && !webhookTriggered) {
      console.log('Live users section is in view, triggering webhook...');
      
      const triggerWebhook = async () => {
        const webhookData = { action: 'show users' };
        
        try {
          console.log('Sending webhook data:', webhookData);
          
          const response = await fetch('https://hook.us2.make.com/o1ovr85o4lhhtynsa4e05rxgwzlkd3sx', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(webhookData),
          });
          
          console.log('Webhook response status:', response.status);
          console.log('Webhook response ok:', response.ok);
          
          if (response.ok) {
            const responseText = await response.text();
            console.log('Live users webhook triggered successfully. Response:', responseText);
            
            // Log the webhook body data
            console.log('=== WEBHOOK RESPONSE BODY ===');
            console.log('Response Body:', responseText);
            console.log('Response Status:', response.status);
            console.log('Response Headers:', Object.fromEntries(response.headers.entries()));
            console.log('=== END WEBHOOK RESPONSE ===');
            
            // Parse the response to extract live users and user requests
            try {
              // Extract numbers from response like "User Requests: 1, Number of Users: 2"
              const userRequestsMatch = responseText.match(/User Requests:\s*(\d+)/);
              const usersMatch = responseText.match(/Number of Users:\s*(\d+)/);
              
              if (userRequestsMatch && usersMatch) {
                const userRequests = parseInt(userRequestsMatch[1]);
                const liveUsers = parseInt(usersMatch[1]);
                
                setWebhookData({
                  liveUsers: liveUsers,
                  userRequests: userRequests
                });
                
                console.log('Extracted webhook data:', { liveUsers, userRequests });
              } else {
                console.log('Could not extract user data from response:', responseText);
                // Set default values if parsing fails
                setWebhookData({
                  liveUsers: 1247,
                  userRequests: 8923
                });
              }
            } catch (parseError) {
              console.log('Error parsing webhook response:', parseError);
              // Set default values if parsing fails
              setWebhookData({
                liveUsers: 1247,
                userRequests: 8923
              });
            }
          } else {
            console.error('Webhook failed with status:', response.status);
            // Set default values if webhook fails
            setWebhookData({
              liveUsers: 1247,
              userRequests: 8923
            });
          }
        } catch (error) {
          console.error('Error triggering live users webhook:', error);
          // Set default values if webhook fails
          setWebhookData({
            liveUsers: 1247,
            userRequests: 8923
          });
        } finally {
          setIsLoading(false);
        }
      };

      triggerWebhook();
      setWebhookTriggered(true);
    }
  }, [isInView, webhookTriggered]);

  const stats = [
    {
      icon: Users,
      label: 'Active Users',
      value: webhookData.liveUsers,
      description: 'Shopkeepers using Chotu.AI right now',
      color: 'text-blue-400'
    },
    {
      icon: MessageCircle,
      label: 'Messages Sent',
      value: liveUsersData.totalMessages.toLocaleString(),
      description: 'Total conversations with Chotu.AI',
      color: 'text-green-400'
    },
    {
      icon: Phone,
      label: 'Help Requests',
      value: webhookData.userRequests.toLocaleString(),
      description: 'Times Chotu was called for help',
      color: 'text-purple-400'
    },
    {
      icon: TrendingUp,
      label: 'Languages',
      value: liveUsersData.languagesUsed,
      description: 'Different languages supported',
      color: 'text-orange-400'
    }
  ];

  return (
    <section id="live-users" ref={ref} className="py-32 px-4 bg-gradient-to-b from-void-black to-gray-900">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <motion.div 
          className="text-center mb-16"
          initial={{ opacity: 0, y: 50 }}
          animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
          transition={{ duration: 1 }}
        >
          <h2 className="font-serif text-5xl md:text-6xl text-white mb-6 tracking-wide">
            Live Community
          </h2>
          <p className="font-sans text-xl text-gray-400 max-w-3xl mx-auto">
            Join thousands of Indian shopkeepers who are already transforming their businesses with Chotu.AI. 
            See the real-time impact of AI-powered commerce.
          </p>
        </motion.div>

        {/* Live Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 mb-16">
          {isLoading ? (
            // Loading skeleton
            Array.from({ length: 4 }).map((_, index) => (
              <motion.div
                key={`loading-${index}`}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-8 text-center"
                initial={{ opacity: 0, y: 30 }}
                animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
                transition={{ duration: 0.8, delay: index * 0.1 }}
              >
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-700/50 mb-6 animate-pulse">
                  <div className="w-7 h-7 bg-gray-600 rounded"></div>
                </div>
                <div className="h-8 bg-gray-700 rounded mb-2 animate-pulse"></div>
                <div className="h-6 bg-gray-700 rounded mb-2 animate-pulse"></div>
                <div className="h-4 bg-gray-700 rounded animate-pulse"></div>
              </motion.div>
            ))
          ) : (
            stats.map((stat, index) => (
              <motion.div
                key={stat.label}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700 rounded-lg p-8 text-center hover:border-gray-600 transition-all duration-300"
                initial={{ opacity: 0, y: 30 }}
                animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
                transition={{ duration: 0.8, delay: index * 0.1 }}
              >
                <div className={`inline-flex items-center justify-center w-16 h-16 rounded-full bg-gray-700/50 mb-6 ${stat.color}`}>
                  <stat.icon size={28} />
                </div>
                <h3 className="font-serif text-3xl md:text-4xl font-bold text-white mb-2">
                  {stat.value}
                </h3>
                <p className="font-sans text-lg font-medium text-white mb-2">
                  {stat.label}
                </p>
                <p className="font-sans text-sm text-gray-400">
                  {stat.description}
                </p>
              </motion.div>
            ))
          )}
        </div>

                          {/* Call to Action */}
         <motion.div
           className="text-center mt-12"
           initial={{ opacity: 0, y: 30 }}
           animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
           transition={{ duration: 1, delay: 1.2 }}
         >
           <p className="font-sans text-lg text-gray-400 mb-6">
             Be part of this growing community of smart shopkeepers
           </p>
           <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
             <button
               onClick={() => scrollToSection('newsletter')}
               className="px-8 py-3 bg-white text-black font-sans font-medium text-lg tracking-wide hover:bg-white/90 transition-all duration-300"
             >
               Join the Revolution
             </button>
             <button
               onClick={testWebhook}
               className="px-6 py-3 bg-transparent border border-gray-500 text-gray-400 font-sans text-sm tracking-wide hover:border-white hover:text-white transition-all duration-300"
             >
               Test Webhook
             </button>
           </div>
         </motion.div>
      </div>
    </section>
  );
};

  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const testWebhook = async () => {
    console.log('Manually testing webhook...');
    const webhookData = { action: 'show users' };
    
    try {
      const response = await fetch('https://hook.us2.make.com/o1ovr85o4lhhtynsa4e05rxgwzlkd3sx', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(webhookData),
      });
      
      console.log('Manual webhook test - Status:', response.status);
      if (response.ok) {
        const responseText = await response.text();
        console.log('Manual webhook test successful. Response:', responseText);
        
        // Log the webhook body data
        console.log('=== MANUAL WEBHOOK RESPONSE BODY ===');
        console.log('Response Body:', responseText);
        console.log('Response Status:', response.status);
        console.log('Response Headers:', Object.fromEntries(response.headers.entries()));
        console.log('=== END MANUAL WEBHOOK RESPONSE ===');
        
        // Try to parse JSON response if possible
        try {
          const responseData = JSON.parse(responseText);
          console.log('Parsed manual webhook response data:', responseData);
        } catch (parseError) {
          console.log('Manual test response is not JSON, raw text:', responseText);
        }
        
        alert('Webhook test successful! Check console for details.');
      } else {
        console.error('Manual webhook test failed with status:', response.status);
        alert('Webhook test failed! Check console for details.');
      }
    } catch (error) {
      console.error('Manual webhook test error:', error);
      alert('Webhook test error! Check console for details.');
    }
  };

export default LiveUsersSection;
