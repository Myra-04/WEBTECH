const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/images', express.static('./.vscode/images'));
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
const supabaseKey = 'sb_publishable_Br9p9Kau2ObdnLnAC4Ku_w_3MAczbI5';
const supabase = createClient(supabaseUrl, supabaseKey);

// --- HELPER: Get Cart Count ---
async function getCartCount(userId) {
    if (!userId) return 0;
    const { count } = await supabase
        .from('cart_items')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
    return count || 0;
}

// --- HELPER: Get Cart Items with Book Details ---
async function getCartItems(userId) {
    if (!userId) return null;
    const { data } = await supabase
        .from('cart_items')
        .select('id, book_id, books(*)') 
        .eq('user_id', userId);
    return data;
}

// --- HOMEPAGE / DIGITAL BOOKSHELF ---
app.get('/', async (req, res) => {
    const userId = req.session.userId;
    const isLoggedIn = !!userId;
    
    let semesterStatus = "🌴 Semester Break! Relax and recharge.";
    let userPurchasedBooks = []; // Updated for the new May requirements
    
    let userUniversity = "Guest";
    let userName = "Student";
    let userEmail = "";

    if (isLoggedIn) {
        const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
        
        if (profile) {
            userUniversity = profile.university;
            userName = profile.full_name; 
            userEmail = profile.email;    
        }

        const month = new Date().getMonth() + 1; 
        if (userUniversity.includes('UTS') && month === 4) {
            semesterStatus = "🌴 UTS Mid-Semester Break!";
        } else if (month >= 9 || month === 1) {
            semesterStatus = "🔥 September Semester is live!";
        } else if (month >= 2 && month <= 6) {
            semesterStatus = "🔥 February Semester is live!";
        }

        // Fetch the user's permanent digital bookshelf!
        const { data: pBooks } = await supabase
            .from('purchased_books')
            .select('*, books(*)')
            .eq('user_id', userId);
            
        if (pBooks) userPurchasedBooks = pBooks;
    }
    
    res.render('index', { 
        cart_count: await getCartCount(userId), 
        cart_items: await getCartItems(userId), 
        is_logged_in: isLoggedIn, 
        semester_status: semesterStatus,
        purchased_books: userPurchasedBooks, // Sends purchased books instead of courses
        university: userUniversity,
        user_name: userName,        
        user_email: userEmail       
    });
});

// --- NEW ROUTE: COURSE TEMPLATE ---
// This allows you to go to http://localhost:3000/course
app.get('/course', async (req, res) => {
    const userId = req.session.userId;
    res.render('course-template', {
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId),
        is_logged_in: !!userId
    });
});

// --- NEW ROUTE: VIDEO SPACES GRID ---
app.get('/spaces', async (req, res) => {
    const userId = req.session.userId;
    const { data: videos } = await supabase.from('videos').select('*');
    
    // Auto-generate the thumbnail images for the grid!
    if (videos && videos.length > 0) {
        videos.forEach(video => {
            const ytId = getYouTubeId(video.video_url);
            if (ytId) {
                // Generates the official high-quality YouTube thumbnail
                video.thumbnail_url = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
            }
        });
    }

    res.render('spaces', { 
        videos: videos || [],
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId),
        is_logged_in: !!userId
    });
});

// --- NEW ROUTE: DYNAMIC VIDEO PLAYER & Q&A ---
app.get('/video/:id', async (req, res) => {
    const userId = req.session.userId;
    const videoId = req.params.id;

    const { data: video } = await supabase.from('videos').select('*').eq('id', videoId).single();
    
    // Convert the standard YouTube link into a playable Embed link
    if (video && video.video_url) {
        const ytId = getYouTubeId(video.video_url);
        if (ytId) {
            video.embed_url = `https://www.youtube.com/embed/${ytId}`;
        }
    }

    const { data: comments } = await supabase
        .from('comments')
        .select('*, profiles(full_name)') 
        .eq('video_id', videoId)
        .order('created_at', { ascending: true });

    res.render('course-template', { 
        video: video,
        comments: comments || [],
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId),
        is_logged_in: !!userId
    });
});

function getYouTubeId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

// --- BOOKSTORE (SEARCH & CURRENCY) ---
app.get('/bookstore', async (req, res) => {
    const userId = req.session.userId;
    const { data: allBooks } = await supabase.from('books').select('*');
    res.render('bookstore', { 
        books: allBooks || [], 
        cart_count: await getCartCount(userId), 
        cart_items: await getCartItems(userId), 
        is_logged_in: !!userId 
    });
});

app.get('/search', async (req, res) => {
    const userId = req.session.userId;
    const searchQuery = req.query.query || '';
    
    // FULL SEARCH: Checks Title, Author, and Course Code!
    const { data: searchResults, error } = await supabase
        .from('books')
        .select('*')
        .or(`title.ilike.%${searchQuery}%,author.ilike.%${searchQuery}%,course_code.ilike.%${searchQuery}%`);
        
    if (error) {
        console.log("🚨 DATABASE SEARCH ERROR:", error.message);
        return res.render('bookstore', { 
            books: [],
            cart_count: await getCartCount(userId),
            cart_items: await getCartItems(userId),
            is_logged_in: !!userId
        }); 
    }
        
    res.render('bookstore', { 
        books: searchResults || [],
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId), 
        is_logged_in: !!userId
    });
});

// --- CART APIs (ADD & REMOVE) ---
app.post('/api/cart/add', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, message: "Please log in first" });

    await supabase.from('cart_items').insert([
        { user_id: userId, book_id: req.body.book_id }
    ]);

    const newCartTotal = await getCartCount(userId);
    res.json({ success: true, new_cart_total: newCartTotal });
});

app.post('/api/cart/remove', async (req, res) => {
    const userId = req.session.userId;
    const { cart_item_id } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: "Not logged in" });

    await supabase
        .from('cart_items')
        .delete()
        .eq('id', cart_item_id)
        .eq('user_id', userId);

    res.json({ success: true });
});

// --- CHECKOUT PAGE ROUTE ---
app.get('/checkout', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
    const cartItems = await getCartItems(userId);

    let subtotal = 0;
    if (cartItems) {
        cartItems.forEach(item => {
            if (item.books && item.books.price) {
                subtotal += parseFloat(item.books.price);
            }
        });
    }

    const platformFee = 2.00;
    const finalTotal = subtotal + platformFee;

    res.render('checkout', {
        cart_items: cartItems || [],
        subtotal: subtotal.toFixed(2),
        platform_fee: platformFee.toFixed(2),
        final_total: finalTotal.toFixed(2),
        user_name: profile ? profile.full_name : ''
    });
});

// --- CHECKOUT PROCESSING API (UPDATED FOR DIGITAL BOOKSHELF) ---
app.post('/api/checkout', async (req, res) => {
    const userId = req.session.userId;
    const { location, phone, total_amount } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: "Not logged in" });

    const cartItems = await getCartItems(userId);
    if (!cartItems || cartItems.length === 0) return res.status(400).json({ success: false, message: "Cart is empty" });

    const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .insert([{ 
            user_id: userId, 
            total_amount: total_amount,
            delivery_location: location,
            phone_number: phone,
            status: 'completed'
        }])
        .select() 
        .single();

    if (orderError) return res.status(500).json({ success: false, message: "Failed to create order." });

    const orderItemsToInsert = cartItems.map(item => ({
        order_id: orderData.id,
        book_id: item.book_id,
        price_at_purchase: item.books.price
    }));
    await supabase.from('order_items').insert(orderItemsToInsert);

    // NEW LOGIC: Move items to the permanent Digital Bookshelf!
    const purchasedBooksToInsert = cartItems.map(item => ({
        user_id: userId,
        book_id: item.book_id
    }));
    await supabase.from('purchased_books').insert(purchasedBooksToInsert);

    // Clear the user's temporary cart
    await supabase.from('cart_items').delete().eq('user_id', userId);

    res.json({ success: true, message: "Order placed! Books added to your digital bookshelf." });
});

// --- AUTHENTICATION (STUDENT PORTAL & SMART ROUTING) ---
app.get('/login', async (req, res) => {
    const userId = req.session.userId;
    if (userId) return res.redirect('/#course-tracker'); 
    
    res.render('student-portal', {
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId) 
    });
});

app.get('/register', async (req, res) => {
    const userId = req.session.userId;
    if (userId) return res.redirect('/#course-tracker');
    
    res.render('student-portal', {
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId) 
    });
});

app.post('/register', async (req, res) => {
    const { email, password, full_name, university } = req.body;
    const emailRegex = /(\.edu|\.my)$/i;
    
    if (!emailRegex.test(email)) {
        return res.status(400).send("Must use a valid .edu or .my student email address.");
    }
    
    const { data, error } = await supabase.auth.signUp({ email, password });
        
    if (error) return res.status(400).send(error.message);

    if (data.user) {
        await supabase.from('profiles').insert([
            { id: data.user.id, full_name: full_name, email: email, university: university }
        ]);
        req.session.userId = data.user.id;
    }
    
    res.redirect('/#course-tracker');
});

app.post('/login', async (req, res) => {
    const { data, error } = await supabase.auth.signInWithPassword({
        email: req.body.email, 
        password: req.body.password,
    });
        
    if (error || !data.user) {
        return res.status(401).send("Invalid email or password");
    }

    req.session.userId = data.user.id;
    res.redirect('/#course-tracker');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));