#!/usr/bin/env python

import re
import os
import os.path
import sys
import argparse


parser = argparse.ArgumentParser(
    prog='Music file sanitizer',
    description='Cleanup unwanted texts from file names, audio data',
    epilog='Text at the bottom of help')

parser.add_argument("--formats", default="mp3,aac,ogg,wma,alac,m4a,wav,flac", help="Comma separated list of file formats to be included in the playlist files.")
parser.add_argument("--wet", action="store_true", help="The flag to actually do the change. If not passed, it will only show what will be changed")
parser.add_argument("--fullpath", action="store_true", help="If true, dry run will print full file path")
parser.add_argument("--sanitize", action="store_true", help="If true, it will sanitize the files names")
parser.add_argument("--clean-hidden", dest="clean_hidden", action="store_true", help="If true, it will delete all hidden files (filename startswith dot(.) )")
parser.add_argument('dir', help="The directory where files are located")



def cleanupHiddenFiles(folder, wetRun):

    if not os.path.exists(folder):
        allErrors.append(f"ERROR: Folder not found: {folder}")
        #print(f"ERROR: Folder not found: {folder}", file=sys.stderr)
        return []

    filesToDelete = []
    for root, dirs, files in os.walk(folder):
        for file in files:
            name, extension = os.path.splitext(file)
            if name.startswith('.'):
                path = os.path.join(root, file)
                if wetRun:
                    print(f"Deleting {path}")
                    os.remove(path)
                else:
                    print(f"DRY will delete {path}")
                    filesToDelete.append(path)


    if not wetRun:
        print(f'dry-run {len(filesToDelete)} files will be deleted')
        print(f'NO ACTION TAKEN. pass --wet for actual run')


def sanitizeMusicFiles(folder, formats, wetRun, fullpath):

    if not os.path.exists(folder):
        allErrors.append(f"ERROR: Folder not found: {folder}")
        #print(f"ERROR: Folder not found: {folder}", file=sys.stderr)
        return []

    totalCount = 0
    for root, dirs, files in os.walk(folder):
        for file in files:
            name, extension = os.path.splitext(file)
            if len(extension)>1 and extension[1:].lower() in formats:

                newFile = sanitizeText(file)
                if file == newFile:
                    continue
                totalCount += 1


                oldPath = os.path.join(root, file)
                newPath = os.path.join(root, newFile)
                if wetRun :
                    print(f'Renaming {oldPath} to {newPath}')
                    os.rename(oldPath, newPath)
                else:
                    if fullpath:
                        print(f'{root}\nOLD: {file}\nNew: {newFile}')
                    else:
                        print(f'OLD: {file}\nNew: {newFile}')

    if not wetRun:
        print(f'Total {totalCount} files will be sanitized')
        if totalCount > 0:
            print(f'NO ACTION TAKEN. pass --wet for actual run')


def sanitizeText(original_text):
    new_text = original_text

    parts = [
        "music.com.bd", "SVF", "Tseries",
        "Full Video", "Full audio", "Full HD", "Full Song",
        "New Video", "New Song", "New audio",
        "High Quality", "best song", "best Quality", "Best Audio", "best video", "best movie",
        "With Lyrics", "Lyrical",
        "The Movie",
        "Hindi Film", "Super Hindi Album", "Hindi Album",
        "ENGlish subtitle", "bangla subtitle", "Eng subtitle", "Eng Sub",
        "Bengali Film", "Bengla Film" , "Bangla Movie", "Eskay Movies"
        "Bangla New Song", "new Bangla song", "new song", "bangla song",
        "Film","Movie", "Songs", "Song", "Music", "Audio",
        "SUBTITLE", "sub title", "Title", "Lyrics", "Lyric", "Video",
        "Quality", "Original", "Official",
        "DVD", "Blue Ray"
        "＂"
    ]

    for part in parts:
        new_text = re.sub(part, '', new_text, flags=re.IGNORECASE)


    new_text = re.sub(r"I+",r'I', new_text)
    new_text = re.sub(r"[(|｜\[\{]+(HQ|HD)[)|｜\]\}]+",r'', new_text, flags=re.IGNORECASE)
    new_text = re.sub(r"\s+\d+p\s+",r'', new_text, flags=re.IGNORECASE)
    
    new_text = re.sub(r"\s*[|(｜\|\-\[\{]+(\s*[)|｜\|\-\]\}])+\s*",r' | ', new_text) # (), [], {}, (   )
    new_text = re.sub(r"\s?[\":：＂]+\s?",r' | ', new_text) # "  :  "
    new_text = re.sub(r"^\.*\s*\d+\.*\s*",r'', new_text) # starts with digit
    

    new_text = re.sub(r"\.+",r'.', new_text) #
    new_text = re.sub(r"\s+",r' ', new_text) #
    new_text = re.sub(r"^[()|｜:：＂'\"\-\[\]\{\}\s]+",r'', new_text)
    new_text = re.sub(r"[(|｜:：＂'\"\-\[\]\{\}\s]+(\.[^\.]+)$",r'\1', new_text)
    #new_text = re.sub(r"[^(]+\s*[)]+(\.[^\.]+)$",r'\1', new_text)
    return new_text

if __name__ == '__main__':
    cliArgs = parser.parse_args()

    formats = cliArgs.formats.lower().split(',')
    wetRun = cliArgs.wet
    sourceDir = cliArgs.dir

    if not ( cliArgs.sanitize or cliArgs.clean_hidden ):
        print(f"Use at least --sanitize or --clean-hidden")

    if cliArgs.sanitize:
        sanitizeMusicFiles(sourceDir, formats, wetRun, cliArgs.fullpath)

    if cliArgs.clean_hidden:
        cleanupHiddenFiles(sourceDir, wetRun)
