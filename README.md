#

I needed a program to create m3u playlist files based on a configuration. This helps to regenerate the playlist in case of new music added/removed or sub directories updates. All you need is to update playlist config.

## Install & Run

1. Activate virtual env (Skip if already available)
```
python3 -m venv venv
source venv/bin/activate
```

2. Install requirements
```
pip3 install -r requirements.txt
```

3. Run the program
```
python3 playlist_generator.py  <config file path>
```


## Sample yaml config

```
sourceDir: "./Music"                      # The directory path where music files are located
targetDir: "./Playlists"                  # The directory path where playlists files will be created

playlists:

#Bangla Playlists
  - name: Bangla - Rabindrashangeet     # Name of the playlist
    sources:                            # List of directories for music files. this can be absoulute path, otherwise it'll use relative to `sourceDir`
      - ./Music/Bangla/Bonna
      - ./Music/Bangla/Indrani
      - ./Music/Bangla/Shahana
    exclusions:                         # List of directories for music files that needs to be excluded, handy when you want to include everything from a folder, but selectively exclude some sub folder.
      - ./Music/Bangla/Nazrul # :p

  - name: Bangla - Bands
    sources:
      - ./Music/Bangla/Souls
      - ./Music/Bangla/Shironamhin
      - ./Music/Bangla/Warfaze
      - ./Music/Bangla/James
    exclusions:

```

