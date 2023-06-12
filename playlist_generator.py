#!/usr/bin/env python

import os
import os.path
import sys
import yaml
import pdb
import argparse
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

parser.add_argument("--targetDir", help="The directory where playlist files will be created. Dir will be created if not exists")
parser.add_argument("--relativeToConfig", help="If true, the playlists files will be created in relative to the config file location")
parser.add_argument('configPath', help="The location of the playlist config file path")


allErrors = []

class PlaylistConfig:
    name: str
    sources: [str]
    exclusions: [str]

    def __init__(self, config):
        self.name = config['name']
        self.sources = config['sources'] if config['sources'] else []
        self.exclusions = config['exclusions'] if config['exclusions'] else []

class MainConfig:
    targetDir: str
    playlists: [PlaylistConfig]

    def __init__(self, config, cliArgs):

        if cliArgs.targetDir:
            self.targetDir = cliArgs.targetDir
        elif config['targetDir']:
            configTargetDir = config['targetDir']
            if os.path.isabs(configTargetDir):
                self.targetDir = configTargetDir
            elif cliArgs.relativeToConfig:
                self.targetDir = os.path.join(os.path.dirname( os.path.abspath(cliArgs.configPath) ), configTargetDir)
            else:
                self.targetDir = configTargetDir
        else:
            self.targetDir = os.getcwd()

        self.playlists = []
        for pc in config['playlists']:
            self.playlists.append(PlaylistConfig(pc))

def readConfig(configFilePath):
    with open(configFilePath, "r") as stream:
        return yaml.safe_load(stream)

def list_mp3_files(folder):

    if not os.path.exists(folder):
        allErrors.append(f"ERROR: Folder not found: {folder}")
        #print(f"ERROR: Folder not found: {folder}", file=sys.stderr)
        return []

    mp3_files = []
    for root, dirs, files in os.walk(folder):
        for file in files:
            if file.lower().endswith('.mp3'):
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
            for file in list_mp3_files(source):
                #print("Adding {}".format(len(file)))
                mp3Files.add(file)
                totalAdded = totalAdded + 1
        #print("Total added: {}".format(totalAdded))

        totalExcluded = 0
        for exclusion in playlistConfig.exclusions:
            for file in list_mp3_files(exclusion):
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
        print("Found {} errors".format(len(allErrors)), file=sys.stderr)
        for error in allErrors:
            print(error, file=sys.stderr)


if __name__ == '__main__':
    args = parser.parse_args()
    print(args)

    main(args)