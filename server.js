const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const app = express();
const port = 5002;
const levenshtein = require("fast-levenshtein"); // นำเข้าไลบรารี Levenshtein สำหรับคำนวณความคล้ายคลึงของข้อความ
const { v4: uuidv4 } = require("uuid");

app.use(cors());
app.use(bodyParser.json());
// Database Pool Configuration
const dbConfig = {
  host: "147.50.227.17",
  user: "drnadech_dbpython",
  password: "94cT*8y4j",
  database: "dbpython",
  waitForConnections: true,
  connectionLimit: 500, // เพิ่มจำนวนการเชื่อมต่อสูงสุดที่รองรับ
  queueLimit: 0, // ไม่จำกัดคิวการเชื่อมต่อ
};

// Create a MySQL Connection Pool
const pool = mysql.createPool(dbConfig);

// Get a connection from the pool
async function getConnection() {
  try {
    return await pool.getConnection();
  } catch (err) {
    console.error("Error getting a connection from the pool:", err);
    throw err;
  }
}

let inputQueue = []; // Queue สำหรับเก็บ input ของผู้ใช้
let waitingForInput = false;
let currentCode = ""; // เก็บโค้ด Python ที่ต้องการรัน
let lastPrompt = "";

app.post("/run-python", (req, res) => {
  // connection = await pool.getConnection();
  inputQueue = []; // เริ่มต้น queue สำหรับเก็บข้อมูล input ของผู้ใช้
  currentCode = req.body.code; // เก็บโค้ด Python ที่รับมาจากไคลเอนต์

  // ตัวแปรสำหรับเก็บ input prompt และเลขบรรทัดของ input() ที่เจอ
  const inputPrompts = [];
  const arr_line = [];
  const inputRegex = /input\(["'](.*?)["']\)/g; // Regex สำหรับค้นหา input() ที่มีข้อความ prompt

  const codeLines = currentCode.split("\n"); // แยกโค้ดออกเป็นบรรทัด เพื่อให้ง่ายต่อการจัดการบรรทัดต่อบรรทัด

  // วนลูปแต่ละบรรทัดของโค้ดเพื่อค้นหาและเก็บ prompt ของ input และเลขบรรทัด
  codeLines.forEach((line, index) => {
    let match;
    while ((match = inputRegex.exec(line)) !== null) {
      inputPrompts.push(match[1]); // เก็บข้อความ prompt ของ input (เช่น "Enter a number:")
      arr_line.push(index + 1); // เก็บเลขบรรทัด (เริ่มที่ 1) ของ prompt
    }
  });

  if (inputPrompts.length > 0) {
    waitingForInput = true;

    // Generate the Python code to run until it reaches an input line in `arr_line`
    let codeTemplate = `
input_values = ${JSON.stringify(inputQueue)};
line_to_pause = ${JSON.stringify(arr_line)};

def input(prompt=""):
    if not input_values:
        raise IndexError("รอข้อมูลเพิ่ม")
    return input_values.pop(0)

paused = False
current_line = 1

# Simulate execution line by line and pause if reaching a line that requires input
for i, line in enumerate(${JSON.stringify(codeLines)}):
    if current_line in line_to_pause:
        paused = True
        break
    exec(line)
    current_line += 1

if not paused:
    print("Code executed without pausing for input.")
`;

    const filePath = path.join(__dirname, "temp.py");
    fs.writeFile(filePath, codeTemplate, (err) => {
      if (err) {
        return res.json({ output: "", error: "Error writing file" });
      }
      exec(`python3 ${filePath}`, (error, stdout, stderr) => {
        fs.unlink(filePath, () => {});

        if (inputPrompts.length > 0) {
          waitingForInput = true;
          res.json({
            waitingForInput: true,
            output: stdout,
            prompt: inputPrompts[inputQueue.length],
          });
        } else if (error) {
          res.json({ status: "error", output: "", error: stderr });
        } else {
          res.json({ status: "done", output: stdout, error: "" });
        }
      });
    });
  } else {
    // If no input prompts, run the entire code
    const codeTemplate = `
input_values = ${JSON.stringify(
      inputQueue
    )}  # กำหนดค่าเริ่มต้นสำหรับ input queue
def input():
    if not input_values:
        raise IndexError("รอข้อมูลเพิ่ม")  # ถ้าไม่มี input ใน queue ให้ส่งสัญญาณว่ารอข้อมูล
    return input_values.pop(0)  # ดึงค่าต่อไปจาก input queue

# รันโค้ดที่ส่งมาจากไคลเอนต์
${currentCode}
`;

    const filePath = path.join(__dirname, "temp.py");

    fs.writeFile(filePath, codeTemplate, (err) => {
      if (err) {
        return res.json({ output: "", error: "Error writing file" }); // จัดการข้อผิดพลาดการเขียนไฟล์
      }

      // เรียกใช้ Python
      exec(`python3 ${filePath}`, (error, stdout, stderr) => {
        fs.unlink(filePath, () => {}); // ลบไฟล์ชั่วคราวหลังจากรันเสร็จ

        // ตรวจสอบผลลัพธ์
        if (stderr) {
          console.error(stderr); // แสดงข้อผิดพลาดใน console
          return res.json({ output: "", error: stderr }); // ส่งข้อผิดพลาดกลับไป
        }

        // ส่ง output กลับไปยังไคลเอนต์
        res.json({ output: stdout.trim(), error: "" }); // ส่งผลลัพธ์ที่ได้จากการรัน
      });
    });
  }
});

// ฟังก์ชันสำหรับการจัดการ input จากผู้ใช้
app.post("/send-input", (req, res) => {
  // connection = await pool.getConnection();
  if (!waitingForInput) {
    return res.json({ success: false, error: "ไม่อยู่ในสถานะรอข้อมูล" });
  }

  const userInput = req.body.userInput;
  inputQueue.push(userInput); // เพิ่มค่าที่ผู้ใช้ป้อนเข้าไปใน inputQueue

  // Prepare updated code with injected inputs
  const updatedCodeTemplate = `
input_values = ${JSON.stringify(inputQueue)};
def input(prompt=""):
    if not input_values:
        raise IndexError("รอข้อมูลเพิ่ม")
    return input_values.pop(0)

${currentCode}
`;
  const filePath = path.join(__dirname, "temp.py");

  fs.writeFile(filePath, updatedCodeTemplate, (err) => {
    if (err) {
      return res.json({ output: "", error: "Error writing file" });
    }

    exec(`python3 ${filePath}`, (error, stdout, stderr) => {
      fs.unlink(filePath, () => {});

      // Check if we are still waiting for input
      waitingForInput = stderr.includes("รอข้อมูลเพิ่ม");

      // Check for the next prompt based on input statements
      const inputRegex = /input\(["'](.*?)["']\)/g;
      const matches = Array.from(currentCode.matchAll(inputRegex));
      const nextPrompt = matches[inputQueue.length]
        ? matches[inputQueue.length][1]
        : null;

      if (waitingForInput && nextPrompt) {
        // หากรอข้อมูลและมี prompt ถัดไป ส่งกลับไป
        res.json({
          waitingForInput: true,
          prompt: nextPrompt,
          output: stdout.trim(),
        });
      } else if (error) {
        // ส่งกลับข้อผิดพลาดถ้ามี
        res.json({ output: "", error: stderr });
      } else {
        // ส่งผลลัพธ์สุดท้ายกลับไป
        res.json({ output: stdout.trim(), error: "" });
      }
    });
  });
});
// app.listen(5001, () => {
//   console.log("Server running on http://localhost:5002");
// });

app.post("/run-python-test", async (req, res) => {
  connection = await pool.getConnection();
  const code = req.body.code;
  const filePath = path.join(__dirname, "temp.py");

  try {
    // connection = await pool.getConnection();
    const idExe = req.body.id_exe;
    const iduserExe = req.body.id;
    const [results] = await connection.execute(
      "SELECT * FROM `answer` WHERE `id_exe` = ?",
      [idExe]
    );

    const allResults = []; // Array สำหรับเก็บผลลัพธ์ทั้งหมด

    for (const val of results) {
      // ตรวจสอบว่าคำตอบในฐานข้อมูลต้องการ input แต่โค้ดของผู้ใช้ไม่มีการใช้ input()
      if (val.ans_input && !code.includes("input(")) {
        allResults.push({
          output: "",
          error: "Error: Expected input in the code but none was found.",
          score: 0,
        });
        continue;
      }

      let updatedCode = code;
      if (val.ans_input) {
        let inputCommands;

        if (val.ans_input.includes(":")) {
          // กรณีที่ ans_input มีเครื่องหมาย ":"
          const cleanInput = val.ans_input
            .split("\n") // แยกบรรทัด
            .map((line) => {
              const parts = line.split(":"); // แยกข้อความก่อนและหลัง ":"
              return parts.length > 1 ? parts[1].trim() : ""; // เก็บเฉพาะค่าหลัง ":" และลบช่องว่าง
            })
            .filter((line) => line !== ""); // กรองบรรทัดที่ว่างออก
          inputCommands = cleanInput
            .map((inputVal) => `input_values.append('${inputVal}')`) // แปลงเป็นคำสั่ง append
            .join("\n");
        } else {
          // กรณีที่ ans_input ไม่มีเครื่องหมาย ":"
          inputCommands = val.ans_input
            .split("\n") // แยกบรรทัด
            .map((inputVal) => `input_values.append('${inputVal.trim()}')`) // ดึงข้อความทั้งบรรทัดมาใช้
            .join("\n");
        }
        updatedCode = `
input_values = []
def input(prompt=''):
    return input_values.pop(0)
${inputCommands}
${code}
        `;
      }

      await fs.promises.writeFile(filePath, updatedCode);
      const execPromise = new Promise((resolve) => {
        exec(`python3 ${filePath}`, (error, stdout, stderr) => {
          fs.unlink(filePath, () => {}); // ลบไฟล์ชั่วคราวหลังจากรันเสร็จสิ้น

          if (error) {
            resolve({ output: "", error: stderr, score: 0 });
          } else {
            const normalizeText = (text) =>
              text
                .replace(/\r\n/g, "\n") // ปรับการขึ้นบรรทัดให้เป็นรูปแบบเดียวกัน
                .replace(/\s+$/g, "") // ลบช่องว่างท้ายข้อความ
                .replace(/ +/g, " ") // ลดช่องว่างหลายช่องให้เหลือเพียงช่องเดียว
                .trim()
                .toLowerCase();

            const ansOutputTrimmed = normalizeText(val.ans_output);
            const stdoutTrimmed = normalizeText(stdout);

            const distance = levenshtein.get(ansOutputTrimmed, stdoutTrimmed);
            const maxLen = Math.max(
              ansOutputTrimmed.length,
              stdoutTrimmed.length
            );
            const similarity = ((maxLen - distance) / maxLen) * 100;
            const score = Math.round(similarity);

            resolve({ output: stdout, error: "", score });
          }
        });
      });

      const result = await execPromise;
      allResults.push(result); // เก็บผลลัพธ์ของแต่ละรอบลงใน allResults
    }
    res.json(allResults); // ส่งผลลัพธ์ทั้งหมดกลับไปยัง client
  } catch (err) {
    console.error("Error querying the database:", err);
    res.json({ output: "", error: "Error querying the database" });
  }
});
app.get("/send-data-chapter", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const id = req.query.id_user;
    const [rows] = await connection.execute(
      `
      SELECT 
    ROUND(avg_data.avg_score, 2) AS avg_score,
    chapter.chapter_id,
    chapter.name,
        chapter.assigned_start,
    chapter.assigned_end
FROM 
    user
LEFT JOIN 
    user_exercise ON user.user_id = user_exercise.id_user
LEFT JOIN 
    exercise ON user_exercise.id_exe = exercise.exe_id
LEFT JOIN 
    chapter ON exercise.id_chapter = chapter.chapter_id
LEFT JOIN (
    SELECT  
        id_user,
        id_chapter,
        ROUND(SUM(score) / COUNT(*), 2) AS avg_score
    FROM 
        user_exercise
    LEFT JOIN 
        exercise ON user_exercise.id_exe = exercise.exe_id
    WHERE 
        id_user = ?
    GROUP BY 
        id_chapter, id_user
) AS avg_data ON chapter.chapter_id = avg_data.id_chapter
WHERE 
    user.user_id = ?
    AND chapter.delete_up IS NULL
    and status_open = 0
GROUP BY  chapter.chapter_id
    `,
      [id, id]
    );

    res.json({ data: rows, serverTime: new Date().toISOString() });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      await connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.get("/send-data-exercises", async (req, res) => {
  connection = await pool.getConnection();

  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const id_chapter = req.query.id_chapter;
    const id_user = req.query.id_user;
    const [rows] = await connection.execute(
      `
        SELECT *,user_exercise.score FROM  user_exercise
LEFT join exercise on  exercise.exe_id = user_exercise.id_exe
LEFT join chapter on exercise.id_chapter = chapter.chapter_id
where chapter.chapter_id = ?  and user_exercise.id_user = ?`,
      [id_chapter, id_user]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.get("/send-work-exercises", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const id_chapter = "1";
    const id_userExe = req.query.id_userExe;

    const [rows] = await connection.execute(
      `SELECT * FROM exercise
LEFT join answer on exercise.exe_id = answer.id_exe
left join user_exercise on exercise.exe_id =  user_exercise.id_exe 
where user_exercise.user_exe_id = ?
`,
      [id_userExe]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/send-send-score", async (req, res) => {
  connection = await pool.getConnection();
  try {
    const code = req.body.code; // ดึง code จาก body ของ request
    const iduserExe = req.body.id; // ดึง iduserExe จาก body ของ request
    const Score = req.body.averageScore; // ดึง Score จาก body ของ request

    if (!code || !iduserExe || Score == null) {
      // ตรวจสอบว่าทุกค่ามีค่าหรือไม่
      return res.status(400).json({ error: "Missing required fields" });
    }

    const [check_time_result] = await connection.execute(
      `SELECT chapter.assigned_end FROM exercise
       LEFT JOIN chapter ON exercise.id_chapter = chapter.chapter_id
       LEFT JOIN user_exercise ON exercise.exe_id = user_exercise.id_exe
       WHERE user_exercise.user_exe_id = ?`,
      [iduserExe]
    );

    const assignedEndTime = check_time_result[0]?.assigned_end;
    const currentTime = new Date();

    if (!assignedEndTime) {
      return res
        .status(400)
        .json({ error: "เกิดข้อผิดพลาดกรุณาลองใหม่อีกครั้ง" });
    }

    if (new Date(assignedEndTime) < currentTime) {
      // ตรวจสอบว่าเวลาที่กำหนดเกินเวลาปัจจุบันแล้วหรือไม่
      return res
        .status(400)
        .json({ error: "ไม่สามารถส่งได้เนื่องจากเกินเวลาที่กำหนด" });
    }

    const [update_code] = await connection.execute(
      `UPDATE user_exercise SET code = ?, complate_status = 1, score = ? WHERE user_exe_id = ?`,
      [code, Score, iduserExe]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "เกิดข้อผิดพลาดกรุณาลองใหม่อีกครั้ง" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.get("/send-data-lesson", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const id_chapter = req.query.id_chapter;

    const [rows] = await connection.execute(
      `
      SELECT * FROM lesson WHERE id_chapter = ?`,
      [id_chapter]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/run-python-simple", async (req, res) => {
  connection = await pool.getConnection();
  const { code, input } = req.body; // รับ `code` และ `input` จาก client
  const filePath = path.join(__dirname, "temp.py");

  try {
    // สร้างโค้ด Python ที่รวม input
    const updatedCode = `
input_values = ${JSON.stringify(input || [])}
def input(prompt=''):
    return input_values.pop(0) if input_values else ''
${code}
    `;

    // เขียนโค้ดลงไฟล์ชั่วคราว
    await fs.promises.writeFile(filePath, updatedCode);

    // สร้าง Promise เพื่อรันคำสั่ง Python
    const execPromise = new Promise((resolve) => {
      exec(`python3 ${filePath}`, (error, stdout, stderr) => {
        // ลบไฟล์ชั่วคราวหลังจากรันเสร็จ
        fs.unlink(filePath, () => {});

        if (error) {
          resolve({ output: "", error: stderr }); // ส่ง error กลับ
        } else {
          resolve({ output: stdout.trim(), error: "" }); // ส่ง output กลับ
        }
      });
    });

    // รอผลลัพธ์จากการรันโค้ด Python และส่งกลับไปยัง client
    const result = await execPromise;
    res.json(result);
  } catch (err) {
    console.error("Error writing or executing the file:", err);
    res.json({ output: "", error: "Error writing or executing the file" });
  }
});
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { connect } = require("http2");
dotenv.config(); // โหลดค่าจาก .env

app.post("/check-login", async (req, res) => {
  let connection;
  const { email, pwd } = req.body;

  try {
    connection = await getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM user
      left join section_open on user.section = section_open.id
      WHERE email = ? AND pwd = ?  and section_open.status = 1`,
      [email, pwd]
    );

    if (rows.length > 0) {
      const user = rows[0];
      const payload = { userId: user.user_id, role: user.role };

      const token = jwt.sign(payload, process.env.JWT_SECRET_KEY, {
        expiresIn: "1d",
      });

      res.json({
        status: "success",
        token,
        userId: user.user_id,
        role: user.role,
      });
    } else {
      res.status(401).json({ status: "error", message: "Invalid credentials" });
    }
  } catch (err) {
    console.error("Error checking login:", err);
    res.status(500).json({ status: "error", message: "Server error" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.post("/data-user", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const user_id = req.body.user_id;

    const [rows] = await connection.execute(
      `SELECT * FROM user WHERE user_id = ? AND delete_up IS NULL`,
      [user_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/data-user-all", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล

    const [rows] = await connection.execute(
      `SELECT 
        user.user_id,
        stdId,
        user_lname,
        user.user_name AS user_name,
        ROUND(SUM(user_exercise.score) / COUNT(user_exercise.score), 2) AS avg_score
      FROM 
        user
      LEFT JOIN 
        user_exercise ON user.user_id = user_exercise.id_user
      LEFT JOIN 
        exercise ON user_exercise.id_exe = exercise.exe_id
      LEFT JOIN 
        chapter ON exercise.id_chapter = chapter.chapter_id
      WHERE 
        chapter.delete_up IS NULL
        AND user.delete_up IS NULL
      GROUP BY 
        user.user_id, user_name
      ORDER BY 
        user.user_id`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});
app.post("/data-lesson", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const [rows] = await connection.execute(
      `SELECT id_chapter,count(*) as total_chapter,chapter.name FROM lesson
LEFT join chapter on lesson.id_chapter = chapter.chapter_id
GROUP by id_chapter
`
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/data-chapter", async (req, res) => {
  connection = await pool.getConnection();
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const [rows] = await connection.execute(
      `SELECT chapter_id,name,count(*) as total_exe ,assigned_start,assigned_end  FROM chapter
LEFT join exercise on chapter.chapter_id = exercise.id_chapter
GROUP by chapter.chapter_id
`
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/data-chapter-select-exe", async (req, res) => {
  connection = await pool.getConnection();
  const chapter_id = req.body.chapter_id;
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const [rows] = await connection.execute(
      `SELECT * FROM chapter
LEFT join exercise on chapter.chapter_id = exercise.id_chapter
WHERE chapter.chapter_id = ?
`,
      [chapter_id]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/data-select-exe", async (req, res) => {
  connection = await pool.getConnection();
  const id_exe_admin = req.body.id_exe_admin;
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const [rows] = await connection.execute(
      `SELECT * FROM exercise WHERE exe_id =  ?
`,
      [id_exe_admin]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

app.post("/send-data-answer", async (req, res) => {
  connection = await pool.getConnection();
  const id_exe = req.body.id_exe;
  try {
    // connection = await initializeDB(); // เรียกการเชื่อมต่อฐานข้อมูล
    const [rows] = await connection.execute(
      `SELECT * FROM answer
WHERE id_exe = ?
`,
      [id_exe]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (connection) {
      connection.release(); // ปิดการเชื่อมต่อ
    }
  }
});

// แก้ตรงนี้
app.post("/add/answers", async (req, res) => {
  connection = await pool.getConnection();
  const { question_id, ans_input, ans_output, code } = req.body;
  try {
    // เพิ่มคำตอบใหม่
    // let connection = await initializeDB();
    const answer_id = uuidv4();

    // เพิ่มข้อมูลในฐานข้อมูล
    const result = await connection.query(
      "INSERT INTO answer (answer_id, id_exe, ans_input, ans_output, code) VALUES (?, ?, ?, ?, ?)",
      [answer_id, question_id, ans_input, ans_output, code]
    );
    res.status(201).json({ success: true, id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.post("/api/answers/:id", async (req, res) => {
  connection = await pool.getConnection();
  const { id } = req.params;
  const { ans_input, ans_output, code } = req.body;

  try {
    // แก้ไขคำตอบเดิม
    // let connection = await initializeDB();
    await connection.query(
      "UPDATE answer SET ans_input = ?, ans_output = ?, code = ? WHERE answer_id = ?",
      [ans_input, ans_output, code, id]
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.post("/api/questions/:id", async (req, res) => {
  connection = await pool.getConnection();
  const { id } = req.params;
  const { question } = req.body;

  try {
    // แก้ไขคำตอบเดิม
    // let connection = await initializeDB();
    await connection.query(
      "UPDATE exercise SET question = ? WHERE exe_id = ?",
      [question, id]
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

const formatMySQLDatetime = (datetime) => {
  const date = new Date(datetime);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
};

app.put("/api/chapters/:id", async (req, res) => {
  connection = await pool.getConnection();
  const { id } = req.params;
  const { name, assigned_start, assigned_end } = req.body;

  try {
    const formattedStart = formatMySQLDatetime(assigned_start);
    const formattedEnd = formatMySQLDatetime(assigned_end);

    // let connection = await initializeDB();
    await connection.query(
      "UPDATE chapter SET name = ?, assigned_start = ?, assigned_end = ? WHERE chapter_id = ?",
      [name, formattedStart, formattedEnd, id]
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Database error" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
