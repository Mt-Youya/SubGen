import fs from 'node:fs'
import path from 'node:path'

// 需要排除的文件扩展名（不处理这些类型的文件）
const EXCLUDED_EXTENSIONS = ['.torrent', '.txt', '.nfo', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.md', '.html', '.htm', '.srt'];

// 匹配番号并标准化为 小写字母-数字 格式
function normalizeCode(filename) {
    // 匹配至少2个字母 + 可选短横线 + 数字
    const match = filename.match(/\b(?:[A-Z]{2,5}|[A-Z]+-\d+)-\d{2,6}[A-Z0-9-]*\b/gi);

    if (match) {
        const letters = match[1];
        console.log('match',match)
        if (!letters) return filename;
        const numbers = match[2];
        // 统一格式：字母小写 + 短横线 + 数字
        const normalized = `${letters?.toLowerCase()}-${numbers}`;
        return normalized;
    }
    return null;
}

// 清理文件名中的 _数字 后缀（处理 .mp4_1 这种情况）
function cleanSuffix(filename) {
    // 先处理扩展名被错误添加后缀的情况：.mp4_1 -> .mp4
    let cleaned = filename.replace(/\.([a-z0-9]+)_\d+$/i, '.$1');
    // 再处理文件夹末尾的 _数字
    cleaned = cleaned.replace(/_\d+$/, '');
    return cleaned;
}

// 检查是否需要排除该文件
function shouldExcludeFile(filename) {
    const ext = path.extname(filename)?.toLowerCase();
    return EXCLUDED_EXTENSIONS.includes(ext);
}

// 检查目标是否存在，如果存在则跳过（不重命名）
function checkAndGetTargetName(dirPath, desiredName, originalName, type) {
    // 如果目标已存在且不是原名称，则跳过
    if (fs.existsSync(path.join(dirPath, desiredName)) && desiredName !== originalName) {
        console.log(`⚠️  跳过重命名 ${type}: ${originalName} -> ${desiredName} (目标已存在，冲突)`);
        return null; // 返回 null 表示跳过
    }

    // 如果目标名称与原名称相同，也跳过
    if (desiredName === originalName) {
        return null; // 无需重命名
    }

    return desiredName;
}

// 重命名项目（文件夹或文件）
function renameItem(dirPath, oldName, newName, type = '文件夹') {
    const oldPath = path.join(dirPath, oldName);
    const newPath = path.join(dirPath, newName);

    try {
        fs.renameSync(oldPath, newPath);
        console.log(`✅ 重命名 ${type}: ${oldName} -> ${newName}`);
        return true;
    } catch (error) {
        console.error(`❌ 重命名失败: ${oldName}`, error.message);
        return false;
    }
}

// 递归处理目录下的所有文件夹和文件
function processDirectory(dirPath, dryRun = false, depth = 0) {
    try {
        const items = fs.readdirSync(dirPath);
        const indent = '  '.repeat(depth);

        // 分离文件夹和文件
        const folders = [];
        const files = [];

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                folders.push(item);
            } else if (stat.isFile()) {
                files.push(item);
            }
        }

        // 先清理当前目录中带有 _数字 后缀的文件和文件夹
        const toClean = [];

        // 清理文件：匹配 .mp4_1 或 ._1.mp4 等情况
        for (const file of files) {
            // 匹配 .扩展名_数字 的情况
            const cleanMatch = file.match(/^(.+?)\.([a-z0-9]+)_(\d+)$/i);
            if (cleanMatch) {
                const cleanedName = `${cleanMatch[1]}.${cleanMatch[2]}`;
                if (cleanedName !== file && !shouldExcludeFile(file)) {
                    toClean.push({oldName: file, newName: cleanedName, type: '文件'});
                }
            }
            // 匹配末尾 _数字 的情况
            else if (file.match(/_\d+\./)) {
                const cleanedName = file.replace(/_\d+\./, '.');
                if (cleanedName !== file && !shouldExcludeFile(file)) {
                    toClean.push({oldName: file, newName: cleanedName, type: '文件'});
                }
            }
        }

        // 清理文件夹：匹配末尾的 _数字
        for (const folder of folders) {
            if (folder.match(/_\d+$/)) {
                const cleanedName = cleanSuffix(folder);
                if (cleanedName !== folder) {
                    toClean.push({oldName: folder, newName: cleanedName, type: '文件夹'});
                }
            }
        }

        // 执行清理重命名
        if (toClean.length > 0) {
            console.log(`\n${indent}🧹 清理 _数字 后缀:`);
            for (const item of toClean) {
                const targetName = dryRun ? item.newName : checkAndGetTargetName(dirPath, item.newName, item.oldName, item.type);
                if (targetName) {
                    console.log(`${indent}  清理: ${item.oldName} -> ${targetName}`);
                    if (!dryRun) {
                        renameItem(dirPath, item.oldName, targetName, item.type);
                    }
                } else {
                    console.log(`${indent}  ⏭️  跳过清理: ${item.oldName} (目标已存在)`);
                }
            }
        }

        // 重新读取目录，获取清理后的项目列表
        const updatedItems = fs.readdirSync(dirPath);
        const updatedFolders = [];
        const updatedFiles = [];

        for (const item of updatedItems) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                updatedFolders.push(item);
            } else if (stat.isFile()) {
                updatedFiles.push(item);
            }
        }

        // 处理当前目录的文件（排除 torrent 等文件）
        const filesToProcess = updatedFiles.filter(file => !shouldExcludeFile(file));
        const excludedFiles = updatedFiles.filter(file => shouldExcludeFile(file));

        if (excludedFiles.length > 0) {
            console.log(`\n${indent}⏭️  排除文件: ${excludedFiles.map(f => path.extname(f).slice(1)).join(', ')} (扩展名在黑名单中)`);
        }

        if (filesToProcess.length > 0) {
            console.log(`\n${indent}📄 处理目录: ${path.basename(dirPath) || dirPath} (${filesToProcess.length} 个文件)`);
            for (const file of filesToProcess) {
                const ext = path.extname(file);
                const nameWithoutExt = path.basename(file, ext);
                const normalizedName = normalizeCode(nameWithoutExt);

                if (normalizedName) {
                    const newFileName = normalizedName + ext;
                    const targetName = dryRun ? newFileName : checkAndGetTargetName(dirPath, newFileName, file, '文件');

                    if (targetName) {
                        console.log(`${indent}  原始: ${file} -> 标准格式: ${targetName}`);
                        if (!dryRun) {
                            renameItem(dirPath, file, targetName, '文件');
                        }
                    } else if (normalizedName && newFileName === file) {
                        console.log(`${indent}  ⏭️  跳过: ${file} (已是标准格式)`);
                    } else if (normalizedName) {
                        console.log(`${indent}  ⏭️  跳过: ${file} (冲突或无需重命名)`);
                    }
                } else {
                    console.log(`${indent}  ⏭️  跳过文件: ${file} (未匹配到番号)`);
                }
            }
        }

        // 处理当前目录的文件夹
        if (updatedFolders.length > 0) {
            console.log(`\n${indent}📁 处理目录: ${path.basename(dirPath) || dirPath} (${updatedFolders.length} 个文件夹)`);

            // 先重命名文件夹
            const processedFolders = [];
            for (const folder of updatedFolders) {
                const normalizedName = normalizeCode(folder);

                if (normalizedName) {
                    const targetName = dryRun ? normalizedName : checkAndGetTargetName(dirPath, normalizedName, folder, '文件夹');

                    if (targetName) {
                        console.log(`${indent}  原始: ${folder} -> 标准格式: ${targetName}`);
                        if (!dryRun) {
                            renameItem(dirPath, folder, targetName, '文件夹');
                            processedFolders.push({
                                oldName: folder,
                                newName: targetName
                            });
                        } else {
                            processedFolders.push({
                                oldName: folder,
                                newName: targetName
                            });
                        }
                    } else if (normalizedName && normalizedName === folder) {
                        console.log(`${indent}  ⏭️  跳过: ${folder} (已是标准格式)`);
                        processedFolders.push({
                            oldName: folder,
                            newName: folder
                        });
                    } else {
                        console.log(`${indent}  ⏭️  跳过: ${folder} (冲突或无需重命名)`);
                        // 即使跳过也要递归处理子目录
                        const subPath = path.join(dirPath, folder);
                        processDirectory(subPath, dryRun, depth + 1);
                    }
                } else {
                    console.log(`${indent}  ⏭️  跳过文件夹: ${folder} (未匹配到番号)`);
                    // 即使没匹配到番号，也要递归处理子目录
                    const subPath = path.join(dirPath, folder);
                    processDirectory(subPath, dryRun, depth + 1);
                }
            }

            // 递归处理已处理的文件夹（包括重命名和未重命名的）
            for (const folder of processedFolders) {
                const folderPath = path.join(dirPath, folder.newName);
                if (fs.existsSync(folderPath)) {
                    processDirectory(folderPath, dryRun, depth + 1);
                }
            }
        }

    } catch (error) {
        console.error(`处理目录失败: ${dirPath}`, error.message);
    }
}

// 主函数
function main() {
    // 获取命令行参数
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('用法: node rename.js <目录路径> [--dry-run]');
        console.log('选项:');
        console.log('  --dry-run      模拟运行，不实际重命名');
        console.log('\n示例:');
        console.log('  node rename.js /path/to/directory');
        console.log('  node rename.js /path/to/directory --dry-run');
        process.exit(1);
    }

    const targetDir = args[0];
    const dryRun = args.includes('--dry-run');

    // 检查目录是否存在
    if (!fs.existsSync(targetDir)) {
        console.error(`错误: 目录不存在 - ${targetDir}`);
        process.exit(1);
    }

    console.log(`📂 目标目录: ${targetDir}`);
    if (dryRun) console.log('🔍 模拟运行模式 (不会实际修改)');
    console.log('='.repeat(50));

    // 递归处理所有目录
    processDirectory(targetDir, dryRun);

    if (!dryRun) {
        console.log('\n✨ 重命名完成');
    } else {
        console.log('\n🔍 模拟运行完成，移除 --dry-run 可实际执行重命名');
    }
}

// 运行主函数
main();