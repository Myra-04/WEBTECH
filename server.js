require('dotenv').config();
const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// This tells Express to look for style.css and images in the main folder
app.use('/static', express.static(__dirname));
app.use(express.static(__dirname));

app.use(session({
    secret: 'study_buddies_secret_123',
    resave: false,
    saveUninitialized: true
}));

// This tells Nunjucks to look in both the main folder AND the 'pages' folder
nunjucks.configure([__dirname, path.join(__dirname, 'pages')], { autoescape: true, express: app });
app.set('view engine', 'html');

// --- SUPABASE CONNECTION ---
const supabaseUrl = 'https://usnhssmiytegieslaweq.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzbmhzc21peXRlZ2llc2xhd2VxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyOTk4MTIsImV4cCI6MjA5Mjg3NTgxMn0.lYt9F8k7CGAM1_FdLCoDMzrgxDMjIhioUi3NSsN6Pm0';
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HELPER: Get Cart Count from Database ---
async function getCartCount(userId) {
    if (!userId) return 0;
    // Count how many items this specific user has in the cart table
    const { count, error } = await supabase
        .from('cart_items')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
    return count || 0;
}

// --- HOMEPAGE, SEMESTER LOGIC & SMART ROUTING ---
app.get('/', async (req, res) => {
    const userId = req.session.userId;
    const isLoggedIn = !!userId;
    
    let semesterStatus = "🌴 Semester Break! Relax and recharge.";
    let userCourses = [];
    let userUniversity = "Guest";

    if (isLoggedIn) {
        // Fetch User Profile to get their University
        const { data: profile } = await supabase.from('profiles').select('university').eq('id', userId).single();
        if (profile) userUniversity = profile.university;

        // Custom Semester Logic based on University (Example)
        const month = new Date().getMonth() + 1; 
        if (userUniversity.includes('UTS') && month === 4) {
            semesterStatus = "🌴 UTS Mid-Semester Break!";
        } else if (month >= 9 || month === 1) {
            semesterStatus = "🔥 September Semester is live!";
        } else if (month >= 2 && month <= 6) {
            semesterStatus = "🔥 February Semester is live!";
        }

       // Fetch ONLY this user's enrolled courses and progress
        const { data: courses } = await supabase.from('user_courses').select('*').eq('user_id', userId);
        
        if (courses) {
            userCourses = courses.map(course => {
                let percentage = 0;
                
                // Calculation: (completed_modules / total_modules) * 100
                if (course.total_modules > 0) {
                    percentage = Math.round((course.completed_modules / course.total_modules) * 100);
                }

                return {
                    ...course,
                    progress_percentage: percentage
                };
            });
        }
    }
    
    res.render('index', { 
        cart_count: await getCartCount(userId), 
        is_logged_in: isLoggedIn, 
        semester_status: semesterStatus,
        courses: userCourses,
        university: userUniversity
    });
});

// --- BOOKSTORE (SEARCH & CURRENCY) ---
app.get('/bookshelf', async (req, res) => {
    const { data: allBooks } = await supabase.from('books').select('*');
    res.render('bookstore', { 
        books: allBooks || [], 
        cart_count: await getCartCount(req.session.userId), 
        is_logged_in: !!req.session.userId 
    });
});

app.get('/search', async (req, res) => {
    const query = req.query.query || '';
    
    // UPDATED: Search by Title OR Author OR Course Code
    const { data: results } = await supabase
        .from('books')
        .select('*')
        .or(`title.ilike.%${query}%,author.ilike.%${query}%,course_code.ilike.%${query}%`);
        
    res.render('bookstore', { 
        books: results || [], 
        cart_count: await getCartCount(req.session.userId), 
        is_logged_in: !!req.session.userId 
    });
});

// --- SHOPPING CART (DATABASE INTEGRATION) ---
app.post('/api/cart/add', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Please log in first" });

    // Insert into Supabase instead of local session
    await supabase.from('cart_items').insert([
        { user_id: userId, book_id: req.body.book_id }
    ]);

    const newCartTotal = await getCartCount(userId);
    res.json({ success: true, new_cart_total: newCartTotal });
});

// --- AUTHENTICATION (STUDENT PORTAL & SMART ROUTING) ---

app.get('/login', (req, res) => {
    // Smart Routing: Bypass portal if already logged in and send to dashboard
    if (req.session.userId) return res.redirect('/#course-tracker'); 
    
    // Render the new combined single-page portal
    res.render('student-portal');
});

app.get('/register', (req, res) => {
    // Smart Routing: Bypass portal if already logged in and send to dashboard
    if (req.session.userId) return res.redirect('/#course-tracker');
    
    // Render the new combined single-page portal
    res.render('student-portal');
});

app.post('/register', async (req, res) => {
    const { email, password, full_name, university } = req.body;

    // EMAIL VALIDATION: Must end in .edu or .my (case insensitive)
    const emailRegex = /(\.edu|\.my)$/i;
    if (!emailRegex.test(email)) {
        return res.status(400).send("Must use a valid .edu or .my student email address.");
    }
    
   // ... top part stays the same
    
    // SUPABASE AUTH: Creates the user securely
    const { data, error } = await supabase.auth.signUp({
        email: email,
        password: password,
    });
        
    if (error) {
        console.log("🚨 AUTH ERROR:", error.message);
        return res.status(400).send(error.message);
    }

    // Create the public profile for the database
    if (data.user) {
        // WE ADDED AN ERROR CATCHER HERE:
        const { error: profileError } = await supabase.from('profiles').insert([
            { id: data.user.id, full_name: full_name, email: email, university: university }
        ]);
        
        if (profileError) {
            console.log("🚨 PROFILE SAVE ERROR:", profileError);
        } else {
            console.log("✅ PROFILE SAVED SUCCESSFULLY!");
        }

        req.session.userId = data.user.id;
    }
    
    // Send directly to dashboard after successful registration
    res.redirect('/#course-tracker');
});

app.post('/login', async (req, res) => {
    console.log("🚨 LOGIN BUTTON CLICKED! Email entered:", req.body.email);
    // SUPABASE AUTH: Secure login check
    const { data, error } = await supabase.auth.signInWithPassword({
        email: req.body.email, 
        password: req.body.password,
    });
        
    if (error || !data.user) {
        return res.status(401).send("Invalid email or password");
    }

    req.session.userId = data.user.id;
    
    // Send directly to dashboard after successful login
    res.redirect('/#course-tracker');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/pages/pages/index.html', (req, res) => res.redirect('/'));
app.get('/pages/pages/bookstore.html', (req, res) => res.redirect('/bookshelf'));
app.get('/pages/pages/student-portal.html', (req, res) => res.redirect('/login'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${process.env.BASE_URL || `http://localhost:${PORT}`}`));
