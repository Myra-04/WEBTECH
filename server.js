const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer'); // ADDED: Required for handling file uploads

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

// ADDED: Setup Multer to store the uploaded file in memory temporarily
const upload = multer({ storage: multer.memoryStorage() });

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
    let userPurchasedBooks = []; 
    let activeCourses = []; 
    
    let userUniversity = "Guest";
    let userName = "Student";
    let userEmail = "";

    if (isLoggedIn) {
        // Get user profile
        const { data: profile } = await supabase.from('profiles').select('*').eq('id', userId).single();
        
        if (profile) {
            userUniversity = profile.university || "Guest";
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

        // 1. Fetch the user's permanent digital bookshelf
        const { data: pBooks } = await supabase
            .from('purchased_books')
            .select('*, books(*)')
            .eq('user_id', userId);
            
        if (pBooks) userPurchasedBooks = pBooks;

        // 2. Fetch the user's watched videos
        const { data: progressData, error: progressError } = await supabase
            .from('video_progress')
            .select('*, videos(*)')
            .eq('user_id', userId);
            
        if (progressError) {
            console.error("🚨 Error fetching progress:", progressError.message);
        }

        // 3. Format the videos so the HTML can easily read them
        if (progressData) {
            activeCourses = progressData.map(p => {
                const ytId = getYouTubeId(p.videos?.video_url);
                return {
                    id: p.video_id,
                    title: p.videos?.title || 'Unknown Video',
                    category: p.videos?.category || 'GENERAL',
                    thumbnail_url: ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : '/images/placeholder.jpg',
                    progress_percentage: p.progress
                };
            });
        }
    }
    
    res.render('index', { 
        cart_count: await getCartCount(userId), 
        cart_items: await getCartItems(userId), 
        is_logged_in: isLoggedIn, 
        semester_status: semesterStatus,
        purchased_books: userPurchasedBooks, 
        courses: activeCourses,
        university: userUniversity,
        user_name: userName,        
        user_email: userEmail       
    });
});

// --- ROUTE: COURSE CATALOG ---
app.get('/courses', async (req, res) => {
    const userId = req.session.userId;
    
    // THE GUARD 
    if (!userId) return res.redirect('/login');

    const { data: allCourses } = await supabase.from('courses').select('*');
    console.log("====== COURSES ROUTE SUCCESSFULLY CALLED!  ======");
    
    res.render('courses', { 
        all_courses: allCourses || [],
        cart_count: await getCartCount(userId),
        is_logged_in: !!userId
    });
});

// --- UPDATED ROUTE: SPECIFIC COURSE MODULES ---
app.get('/modules/:courseId', async (req, res) => {
    const userId = req.session.userId;

    //THE GUARD 
    if (!userId) return res.redirect('/login');

    const courseId = req.params.courseId;

    // 1. Fetch the main course details
    const { data: course } = await supabase.from('courses').select('*').eq('id', courseId).single();
    
    // 2. Fetch the chapters for this course
    const { data: chapters } = await supabase.from('course_chapters').select('*').eq('course_id', courseId).order('chapter_number', { ascending: true });

    // 3. Find the student's quiz scores and merge them into the chapters (For the frontend progress bar)
    if (userId && chapters) {
        const { data: scores } = await supabase.from('quiz_scores').select('chapter_id, score').eq('user_id', userId);
        
        chapters.forEach(chapter => {
            // Check if the student has a score for this specific chapter
            const chapterScore = scores?.find(s => s.chapter_id === chapter.id);
            // Inject the score as 'progress' so the HTML template can read it
            chapter.progress = chapterScore ? chapterScore.score : 0; 
        });
    }

    res.render('course-module', {
        course: course,
        chapters: chapters || [],
        cart_count: await getCartCount(userId),
        is_logged_in: !!userId
    });
});

// --- NEW ROUTE: INTERACTIVE QUIZ ENGINE ---
app.get('/quiz/:chapterId', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login'); // Secure the quiz!

    const chapterId = req.params.chapterId;

    // Fetch questions from Supabase
    const { data: questions } = await supabase.from('quiz_questions').select('*').eq('chapter_id', chapterId);

    // Convert to JSON string for the frontend to use in JavaScript
    const questionsJson = JSON.stringify(questions || []);

    res.render('quiz', {
        chapter_id: chapterId,
        questions_json: questionsJson,
        cart_count: await getCartCount(userId),
        is_logged_in: !!userId
    });
});

// --- NEW API: SUBMIT QUIZ SCORE ---
app.post('/api/quiz/submit', async (req, res) => {
    const userId = req.session.userId;
    const { chapter_id, course_id, score } = req.body; // Assuming the form sends these three things

    if (!userId) return res.status(401).send("Unauthorized");

    // Upsert the score into the database (Update if exists, Insert if new)
    const { error } = await supabase.from('quiz_scores').upsert({
        user_id: userId,
        chapter_id: chapter_id,
        score: score,
        updated_at: new Date()
    }, { onConflict: 'user_id, chapter_id' }); // Assuming you set a unique constraint in Supabase

    if (error) {
        console.error("🚨 Quiz Save Error:", error.message);
        return res.status(500).send("Error saving score");
    }

    // Redirect the user back to the modules page so they can see their progress
    res.redirect(`/modules/${course_id}`); 
});

// --- NEW ROUTE: VIDEO SPACES GRID ---
app.get('/spaces', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');
    const { data: videos } = await supabase.from('videos').select('*');
    
    // Auto-generate the thumbnail images for the grid!
    if (videos && videos.length > 0) {
        videos.forEach(video => {
            const ytId = getYouTubeId(video.video_url);
            if (ytId) {
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

// --- NEW ROUTE: DYNAMIC VIDEO PLAYER, Q&A, AND NOTES ---
app.get('/video/:id', async (req, res) => {
    const userId = req.session.userId;
    const videoId = req.params.id;

    const { data: video } = await supabase.from('videos').select('*').eq('id', videoId).single();
    
    if (video && video.video_url) {
        const ytId = getYouTubeId(video.video_url);
        if (ytId) {
            video.embed_url = `https://www.youtube.com/embed/${ytId}?enablejsapi=1&origin=http://localhost:3000`;
        }
    }

    const { data: comments } = await supabase
        .from('comments')
        .select('*, profiles(full_name)') 
        .eq('video_id', videoId)
        .order('created_at', { ascending: true });

    const { data: notes } = await supabase
        .from('notes')
        .select('*, profiles(full_name)')
        .eq('video_id', videoId)
        .order('created_at', { ascending: false });

    // NEW FIX: Check if the user has watched this before and grab their percentage!
    let savedProgress = 0;
    if (userId) {
        const { data: progressData } = await supabase
            .from('video_progress')
            .select('progress')
            .eq('user_id', userId)
            .eq('video_id', videoId)
            .single();
        
        if (progressData) {
            savedProgress = progressData.progress;
        }
    }

    res.render('course-template', { 
        video: video,
        comments: comments || [],
        notes: notes || [],
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId),
        is_logged_in: !!userId,
        saved_progress: savedProgress // 👈 Hand the percentage over to the HTML
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
    if (!userId) return res.redirect('/login'); 

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

// --- CHECKOUT PROCESSING API (WITH EXTREME DEBUGGING) ---
app.post('/api/checkout', async (req, res) => {
    const userId = req.session.userId;
    const { location, phone, total_amount } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: "Not logged in" });

    try {
        console.log("-----------------------------------------");
        console.log("🛒 Checkout started for user:", userId);

        const cartItems = await getCartItems(userId);
        if (!cartItems || cartItems.length === 0) {
            console.log("❌ Checkout failed: Cart is empty.");
            return res.status(400).json({ success: false, message: "Cart is empty" });
        }

        console.log("📦 1. Attempting to create Order in 'orders' table...");
        const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .insert([{ 
                user_id: userId, 
                total_amount: total_amount ? parseFloat(total_amount) : 0, 
                delivery_location: location || 'Digital Delivery',
                phone_number: phone || 'N/A',
                status: 'completed'
            }])
            .select() 
            .single();

        if (orderError) {
            console.log("🚨 ERROR IN 'orders' TABLE:", orderError.message);
            return res.status(500).json({ success: false, message: "Failed to create order." });
        }

        console.log("🧾 2. Attempting to save items to 'order_items' table...");
        const orderItemsToInsert = cartItems.map(item => ({
            order_id: orderData.id,
            book_id: item.book_id,
            price_at_purchase: item.books.price
        }));
        const { error: itemsError } = await supabase.from('order_items').insert(orderItemsToInsert);

        if (itemsError) {
            console.log("🚨 ERROR IN 'order_items' TABLE:", itemsError.message);
            return res.status(500).json({ success: false, message: "Failed to save items." });
        }

        console.log("📚 3. Attempting to add books to 'purchased_books' table...");
        const purchasedBooksToInsert = cartItems.map(item => ({
            user_id: userId,
            book_id: item.book_id
        }));
        const { error: pbError } = await supabase.from('purchased_books').insert(purchasedBooksToInsert);

        if (pbError) {
            console.log("🚨 ERROR IN 'purchased_books' TABLE:", pbError.message);
            return res.status(500).json({ success: false, message: "Failed to add to digital shelf." });
        }

        console.log("🗑️ 4. Attempting to clear the cart...");
        const { error: clearError } = await supabase.from('cart_items').delete().eq('user_id', userId);

        if (clearError) {
            console.log("🚨 ERROR CLEARING CART:", clearError.message);
        }

        console.log("✅ CHECKOUT 100% COMPLETE!");
        console.log("-----------------------------------------");
        res.json({ success: true, message: "Order placed! Books added to your digital bookshelf." });

    } catch (err) {
        console.log("🚨 CRITICAL SERVER CRASH:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// --- NEW API: ADD A COMMENT ---
app.post('/api/comments/add', async (req, res) => {
    const userId = req.session.userId;
    const { video_id, comment_text } = req.body;

    if (!userId) return res.redirect('/login');

    const { error } = await supabase.from('comments').insert([
        { video_id: video_id, user_id: userId, comment_text: comment_text }
    ]);

    if (error) console.error("🚨 Comment Error:", error.message);
    res.redirect(`/video/${video_id}`);
});

// --- NEW API: UPLOAD NOTES TO SUPABASE STORAGE ---
app.post('/api/notes/upload', upload.single('note_file'), async (req, res) => {
    const userId = req.session.userId;
    const videoId = req.body.video_id;
    const file = req.file; 

    if (!userId) return res.redirect('/login');
    if (!file) return res.status(400).send("Please select a file.");

    try {
        const uniqueFileName = `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`;

        const { error: storageError } = await supabase.storage
            .from('course_notes')
            .upload(uniqueFileName, file.buffer, {
                contentType: file.mimetype
            });

        if (storageError) throw storageError;

        const { data: publicUrlData } = supabase.storage
            .from('course_notes')
            .getPublicUrl(uniqueFileName);
        
        const fileUrl = publicUrlData.publicUrl;

        await supabase.from('notes').insert([
            { video_id: videoId, user_id: userId, file_name: file.originalname, file_url: fileUrl }
        ]);

        res.redirect(`/video/${videoId}`);
    } catch (error) {
        console.error("Upload Error:", error.message);
        res.status(500).send("Failed to upload note.");
    }
});

// --- NEW API: SAVE VIDEO PROGRESS (WITH EXTREME DEBUGGING) ---
app.post('/api/video/progress', async (req, res) => {
    console.log("-----------------------------------------");
    console.log("📡 Progress Signal Received from HTML!");
    
    const userId = req.session.userId;
    const { video_id, progress } = req.body;

    console.log("User ID:", userId);
    console.log("Video ID:", video_id);
    console.log("Progress:", progress + "%");

    if (!userId) {
        console.log("❌ Failed: The server thinks you are not logged in.");
        return res.status(401).json({ success: false });
    }

    try {
        // Check if the user already started this video
        const { data: existing, error: fetchError } = await supabase
            .from('video_progress')
            .select('*')
            .eq('user_id', userId)
            .eq('video_id', video_id)
            .single();

        // Error code PGRST116 just means "0 rows found", which is normal for the first time!
        if (fetchError && fetchError.code !== 'PGRST116') {
            console.log("🚨 DATABASE FETCH ERROR:", fetchError.message);
        }

        if (existing) {
            console.log("🔄 Found existing record! Updating...");
            const { error: updateError } = await supabase.from('video_progress').update({ progress: progress }).eq('id', existing.id);
            if (updateError) console.log("🚨 DATABASE UPDATE ERROR:", updateError.message);
        } else {
            console.log("🆕 First time watching! Inserting new record...");
            const { error: insertError } = await supabase.from('video_progress').insert([{ user_id: userId, video_id: video_id, progress: progress }]);
            if (insertError) console.log("🚨 DATABASE INSERT ERROR:", insertError.message);
        }

        console.log("✅ Checkpoint Saved!");
        console.log("-----------------------------------------");
        res.json({ success: true });
    } catch (err) {
        console.log("🚨 CRITICAL SERVER ERROR:", err.message);
        res.status(500).json({ success: false });
    }
});

// --- AUTHENTICATION (STUDENT PORTAL & SMART ROUTING) ---
app.get('/login', async (req, res) => {
    const userId = req.session.userId;
    if (userId) return res.redirect('/#dashboard'); 
    
    res.render('student-portal', {
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId) 
    });
});

app.get('/register', async (req, res) => {
    const userId = req.session.userId;
    if (userId) return res.redirect('/#dashboard');
    
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
    
    res.redirect('/#dashboard');
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
    res.redirect('/#dashboard');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));