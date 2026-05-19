const express = require('express');
const session = require('express-session');
const nunjucks = require('nunjucks');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer'); 

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

const upload = multer({ storage: multer.memoryStorage() });

nunjucks.configure([__dirname, path.join(__dirname, 'pages')], { autoescape: true, express: app });
app.set('view engine', 'html');

// --- SUPABASE CONNECTION ---
const supabaseUrl = 'https://usnhssmiytegieslaweq.supabase.co';
const supabaseKey = 'sb_publishable_Br9p9Kau2ObdnLnAC4Ku_w_3MAczbI5';
const supabase = createClient(supabaseUrl, supabaseKey);

async function getCartCount(userId) {
    if (!userId) return 0;
    const { count } = await supabase
        .from('cart_items')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
    return count || 0;
}

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
    let recentVideos = []; 
    let activeCourses = []; 
    
    let userUniversity = "Guest";
    let userName = "Student";
    let userEmail = "";

    if (isLoggedIn) {
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

        const { data: pBooks } = await supabase
            .from('purchased_books')
            .select('*, books(*)')
            .eq('user_id', userId);
            
        if (pBooks) userPurchasedBooks = pBooks;

        const { data: progressData } = await supabase
            .from('video_progress')
            .select('*, videos(*)')
            .eq('user_id', userId);
            
        if (progressData) {
            recentVideos = progressData.map(p => {
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

        const { data: scoresData } = await supabase
            .from('quiz_scores')
            .select('chapter_id, score')
            .eq('user_id', userId);
            
        if (scoresData && scoresData.length > 0) {
            const chapterIds = scoresData.map(s => s.chapter_id);
            const { data: scoredChapters } = await supabase.from('course_chapters').select('course_id, courses(*)').in('id', chapterIds);

            if (scoredChapters) {
                const courseMap = new Map();
                const uniqueCourseIds = [...new Set(scoredChapters.map(ch => ch.course_id))];

                for (const courseId of uniqueCourseIds) {
                    const { data: allCourseChapters } = await supabase.from('course_chapters').select('*').eq('course_id', courseId);
                    const chapterWithCourseDetail = scoredChapters.find(ch => ch.course_id === courseId);
                    
                    if (chapterWithCourseDetail && chapterWithCourseDetail.courses) {
                        const courseDetails = chapterWithCourseDetail.courses;
                        let totalScore = 0;
                        let totalChaptersCount = allCourseChapters ? allCourseChapters.length : 1; 

                        if (allCourseChapters) {
                            allCourseChapters.forEach(cc => {
                                const s = scoresData.find(score => score.chapter_id === cc.id);
                                if (s) { 
                                    totalScore += s.score; 
                                }
                            });
                        }

                        const avgProgress = Math.round(totalScore / totalChaptersCount);

                        courseMap.set(courseId, {
                            id: courseId,
                            title: courseDetails.title,
                            category: courseDetails.category,
                            thumbnail_url: courseDetails.thumbnail_url || '/images/placeholder.jpg',
                            progress_percentage: avgProgress
                        });
                    }
                }
                
                activeCourses = Array.from(courseMap.values());
            }
        }
    }
    
    res.render('index', { 
        cart_count: await getCartCount(userId), 
        cart_items: await getCartItems(userId), 
        is_logged_in: isLoggedIn, 
        semester_status: semesterStatus,
        purchased_books: userPurchasedBooks, 
        recent_videos: recentVideos,
        active_courses: activeCourses,
        university: userUniversity,
        user_name: userName,        
        user_email: userEmail       
    });
});

app.get('/courses', async (req, res) => {
    const userId = req.session.userId;
    const { data: allCourses } = await supabase.from('courses').select('*');
    
    res.render('courses', { 
        all_courses: allCourses || [],
        cart_count: await getCartCount(userId),
        is_logged_in: !!userId
    });
});

app.get('/modules/:courseId', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    const courseId = req.params.courseId;
    const { data: course } = await supabase.from('courses').select('*').eq('id', courseId).single();
    const { data: chapters } = await supabase.from('course_chapters').select('*').eq('course_id', courseId).order('chapter_number', { ascending: true });

    if (userId && chapters) {
        const { data: scores } = await supabase.from('quiz_scores').select('chapter_id, score').eq('user_id', userId);
        chapters.forEach(chapter => {
            const chapterScore = scores?.find(s => s.chapter_id === chapter.id);
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

app.get('/quiz/:chapterId', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');

    const chapterId = req.params.chapterId;
    
    const { data: questions } = await supabase.from('quiz_questions').select('*').eq('chapter_id', chapterId);
    const questionsJson = JSON.stringify(questions || []);
    const { data: chapterData } = await supabase.from('course_chapters').select('course_id').eq('id', chapterId).single(); 
    const currentCourseId = chapterData ? chapterData.course_id : 1; 

    res.render('quiz', {
        chapter_id: chapterId,
        course_id: currentCourseId, 
        questions_json: questionsJson,
        cart_count: await getCartCount(userId),
        is_logged_in: !!userId
    });
});

// --- UPDATED API: QUIZ SUBMISSION (100% CHECK) ---
app.post('/api/quiz/submit', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).send("Unauthorized");
    
    const finalChapterId = parseInt(req.body.chapter_id) || 0;
    const actualQuizScore = parseInt(req.body.score) || 0;
    const finalCourseId = req.body.course_id || 1; 

    // THE FIX: Only save the score to the progress table IF it is exactly 100%
    if (actualQuizScore === 100) {
        const { error } = await supabase.from('quiz_scores').upsert({
            user_id: userId,
            chapter_id: finalChapterId,
            score: 100, // Chapter is now 100% complete!
            updated_at: new Date()
        }, { onConflict: 'user_id, chapter_id' });

        if (error) {
            console.error("🚨 Quiz Save Error:", error.message);
            return res.status(500).send("Error saving score");
        }
        
        // Success! Send them back with a 'passed' flag in the URL
        res.redirect(`/modules/${finalCourseId}?quiz=passed`);
    } else {
        // They failed. Do NOT overwrite their 66% progress from the tutorial!
        res.redirect(`/modules/${finalCourseId}?quiz=failed&score=${actualQuizScore}`);
    }
});

app.get('/spaces', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/login');
    const { data: videos } = await supabase.from('videos').select('*');
    
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

    const { data: allComments } = await supabase
        .from('comments')
        .select('*, profiles(full_name)') 
        .eq('video_id', videoId)
        .order('created_at', { ascending: true });

    let threadedComments = [];
    if (allComments) {
        threadedComments = allComments.filter(c => !c.parent_id);
        threadedComments.forEach(parent => {
            parent.replies = allComments.filter(c => c.parent_id === parent.id);
        });
    }

    const { data: notes } = await supabase
        .from('notes')
        .select('*, profiles(full_name)')
        .eq('video_id', videoId)
        .order('created_at', { ascending: false });

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
        comments: threadedComments || [], 
        notes: notes || [],
        cart_count: await getCartCount(userId),
        cart_items: await getCartItems(userId),
        is_logged_in: !!userId,
        saved_progress: savedProgress
    });
});

function getYouTubeId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

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

app.post('/api/checkout', async (req, res) => {
    const userId = req.session.userId;
    const { location, phone, total_amount } = req.body;

    if (!userId) return res.status(401).json({ success: false, message: "Not logged in" });

    try {
        const cartItems = await getCartItems(userId);
        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({ success: false, message: "Cart is empty" });
        }

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

        if (orderError) throw orderError;

        const orderItemsToInsert = cartItems.map(item => ({
            order_id: orderData.id,
            book_id: item.book_id,
            price_at_purchase: item.books.price
        }));
        const { error: itemsError } = await supabase.from('order_items').insert(orderItemsToInsert);

        if (itemsError) throw itemsError;

        const purchasedBooksToInsert = cartItems.map(item => ({
            user_id: userId,
            book_id: item.book_id
        }));
        const { error: pbError } = await supabase.from('purchased_books').insert(purchasedBooksToInsert);

        if (pbError) throw pbError;

        await supabase.from('cart_items').delete().eq('user_id', userId);

        res.json({ success: true, message: "Order placed! Books added to your digital bookshelf." });

    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post('/api/comments/add', async (req, res) => {
    const userId = req.session.userId;
    const { video_id, comment_text, parent_id } = req.body;

    if (!userId) return res.redirect('/login');

    const insertData = { video_id: video_id, user_id: userId, comment_text: comment_text };
    if (parent_id) {
        insertData.parent_id = parent_id;
    }

    const { error } = await supabase.from('comments').insert([insertData]);

    if (error) console.error("🚨 Comment Error:", error.message);
    res.redirect(`/video/${video_id}`);
});

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

// --- API: TRACK BUTTON CLICKS (SLIDES & TUTORIALS) ---
app.post('/api/chapter/progress', async (req, res) => {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false });

    const { chapter_id, progress } = req.body;

    // Fetch current score to make sure we don't lower it!
    const { data: existing } = await supabase.from('quiz_scores').select('score').eq('user_id', userId).eq('chapter_id', chapter_id).single();
    const currentScore = existing ? existing.score : 0;

    // Only update if the new progress is higher than their current progress
    if (progress > currentScore) {
        await supabase.from('quiz_scores').upsert({
            user_id: userId,
            chapter_id: chapter_id,
            score: progress,
            updated_at: new Date()
        }, { onConflict: 'user_id, chapter_id' });
    }

    res.json({ success: true });
});

app.post('/api/video/progress', async (req, res) => {
    const userId = req.session.userId;
    const { video_id, progress } = req.body;

    if (!userId) return res.status(401).json({ success: false });

    try {
        const { data: existing, error: fetchError } = await supabase
            .from('video_progress')
            .select('*')
            .eq('user_id', userId)
            .eq('video_id', video_id)
            .single();

        if (existing) {
            await supabase.from('video_progress').update({ progress: progress }).eq('id', existing.id);
        } else {
            await supabase.from('video_progress').insert([{ user_id: userId, video_id: video_id, progress: progress }]);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});