#!/usr/bin/env python

import os
import os.path
import sys
import yaml
import pdb
import argparse
from pprint import pprint
from pathlib import Path
from mutagen.mp3 import MP3

def validateTargetDir(targetDir):
    
    if os.path.isabs(configTargetDir):
        raise ValueError  # or TypeError, or `argparse.ArgumentTypeError
    return astring


parser = argparse.ArgumentParser(
    prog='PlaylistMaker',
    description='Makes Playlist from directories based on configuration',
    epilog='Text at the bottom of help')

parser.add_argument("--sourceDir", help="The directory containing the music files")
parser.add_argument("--targetDir", help="The directory where playlist files will be created. Dir will be created if not exists")
parser.add_argument("--relativeToConfig", action="store_true", help="If true, the playlists files will be created in relative to the config file location")
parser.add_argument("--formats", default="mp3,aac,ogg,wma,alac,m4a,wav,flac", help="Comma separated list of file formats to be included in the playlist files.")
parser.add_argument('configPath', help="The location of the playlist config file path")


allErrors = []


def findRightDir(dir1, dir2, relativeToConfig, configPath):
    if dir1:
        return dir1
    elif dir2:
        if os.path.isabs(dir2) or not relativeToConfig:
            return dir2
        else:
            return os.path.join(os.path.dirname( os.path.abspath(configPath) ), dir2)
    else:
        self.targetDir = os.getcwd()

class PlaylistConfig:
    name: str
    sources: [str]
    exclusions: [str]

    def __init__(self, config):
        self.name = config['name']
        self.sources = config['sources']
        self.exclusions = config.get('exclusions', []) if ('exclusions' in config and config['exclusions'] is not None) else []
        #print("{}: {} : {}".format(self.name, self.exclusions, 'exclusions' in config ))

class MainConfig:
    sourceDir: str
    targetDir: str
    formats: []
    playlists: [PlaylistConfig]

    def __init__(self, config, cliArgs):

        
        self.targetDir = findRightDir(cliArgs.targetDir, config['targetDir'], cliArgs.relativeToConfig, cliArgs.configPath)
        self.sourceDir = findRightDir(cliArgs.sourceDir, config['sourceDir'], cliArgs.relativeToConfig, cliArgs.configPath)
        self.formats = cliArgs.formats.lower().split(',')
        self.playlists = []
        for pc in config['playlists']:
            self.playlists.append(PlaylistConfig(pc))

def readConfig(configFilePath):
    with open(configFilePath, "r") as stream:
        return yaml.safe_load(stream)

def listMusicFiles(mainConfig, folder):

    if not os.path.exists(folder):
        allErrors.append(f"ERROR: Folder not found: {folder}")
        #print(f"ERROR: Folder not found: {folder}", file=sys.stderr)
        return []

    mp3_files = []
    for root, dirs, files in os.walk(folder):
        for file in files:
            name, extension = os.path.splitext(file)
            if len(extension)>1 and extension[1:].lower() in mainConfig.formats:
                path = os.path.join(root, file)
                mp3_files.append(path)

    return mp3_files


def makePlaylist(playlistFilePath, mp3FilePaths):
    with open(playlistFilePath, 'w') as outputFile:

        outputFile.write("#EXTM3U\n")
        for mp3FilePath in mp3FilePaths:

            try:
                # Calculate MP3 music length
                audio = MP3(mp3FilePath)
                length = int(audio.info.length)

                #print("id3: {}".format(audio.tags.keys()))
                #tit1 = audio.tags['TIT1'] if audio.tags is defined else ''
                #tit2 = audio.tags['TIT2'] if audio.tags is defined else ''
                #filename = Path(mp3FilePath).stem
                #title = tit2 if tit2 is not empty else (tit1 if tit1 is not empty else (filename))

                # Write line to playlist file
                relPath = os.path.relpath(mp3FilePath, os.path.dirname(playlistFilePath))
                outputFile.write(f"#EXTINF:{length}\n{relPath}\n")
            except:
                allErrors.append("ERROR: Issue reading mp3: {}".format(mp3FilePath))
                #print("ERROR: Issue reading mp3: {}".format(mp3FilePath), file=sys.stderr)
            



def main(args):
    yamlConfig = readConfig(args.configPath)
    mainConfig = MainConfig(yamlConfig, args)

    targetDir = mainConfig.targetDir
    playlistConfigs = mainConfig.playlists

    if not os.path.exists(targetDir):
        os.makedirs(targetDir)

    fullTargetDirPath = os.path.abspath(targetDir)
    print("Writing all playlist files to {}".format(fullTargetDirPath))

    for playlistConfig in playlistConfigs:
        playlistName = playlistConfig.name
        print("Making plalist: {}".format(playlistName))

        mp3Files = set()
        totalAdded = 0
        for source in playlistConfig.sources:
            xx = source if os.path.isabs(source) else os.path.join(mainConfig.sourceDir, source)
            for file in listMusicFiles(mainConfig, xx):
                #print("Adding {}".format(len(file)))
                mp3Files.add(file)
                totalAdded = totalAdded + 1
        #print("Total added: {}".format(totalAdded))

        totalExcluded = 0
        for exclusion in playlistConfig.exclusions:
            xx = exclusion if os.path.isabs(exclusion) else os.path.join(mainConfig.sourceDir, exclusion)
            for file in listMusicFiles(mainConfig, exclusion):
                #print("Removed {}".format(len(file)))
                mp3Files.remove(file)
                totalExcluded = totalExcluded + 1
        #print("Total excluded: {}".format(totalExcluded))

        if len(mp3Files) > 0 :
            playlistFilePath = os.path.join(targetDir, playlistName + '.m3u')
            makePlaylist(playlistFilePath, mp3Files)
            print("Done with {} files\n".format(len(mp3Files)))
        else:
            allErrors.append("SKIPPED {} due to no available music:".format(playlistName)
             + "totalAdded {}, totalExcluded {} , finalTotal {}"
             .format(
                totalAdded,
                totalExcluded,
                len(mp3Files)
            ))

    if len(allErrors) > 0:
        print("\nFound {} errors".format(len(allErrors)), file=sys.stderr)
        for error in allErrors:
            print(error, file=sys.stderr)


if __name__ == '__main__':
    args = parser.parse_args()
    #print(args)

    main(args)
