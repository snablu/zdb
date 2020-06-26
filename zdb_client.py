import sys
import os
import socket

# TODO: read from config file
HOST = '172.27.48.1'
PORT = 7340

def main():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.connect((HOST, PORT))
        # sock.sendall(b'hi there')
        while True:
            command = input()
            if command == 'exit':
                sys.exit()
            server_command, expect_response = getServerCommand(command)
            # send server command if applicable
            if server_command:
                sock.sendall(server_command.encode('ascii'))
                if expect_response:
                    print(sock.recv(1024).decode('ascii'))


def getServerCommand(command: str):
    split = command.split()
    print(split)
    if split[0] == 'actor':
        print(int(split[2], base=16))
        setActor(split[1], int(split[2], base=16))
        print(cur_actor_offset)
        return None, False
    elif split[0] == 'b':
        break_addr, found_overlay = getFunctionBreakPoint(split[1])
        if found_overlay:
            return 'b ovl {} {}'.format(found_overlay, break_addr), False
        else:
            return 'b {}'.format(break_addr), False

# print error message and exit with error
def fail(error_msg: str):
    print(error_msg, file=sys.stderr)
    sys.exit(1)

#TODO: move to OOT-specific logic to own module
# OOT_DIRPATH = '/home/brian/gamedev/oot'
MAP_FILEPATH = '/home/brian/gamedev/oot/build/z64.map'

cur_actor_name = ''
cur_actor_offset = 0

def getFunctionBreakPoint(funcName: str) -> int:
    try:
        with open(MAP_FILEPATH) as f:
            lines = f.readlines()
    except Exception:
        fail(f'Could not open {MAP_FILEPATH} as a map file for reading')

    # find function address in ROM - logic borrowed from diff.py
    # cur_objfile = None
    # ram_to_rom = None
    curOverlay = None
    foundOverlay = None
    objfile = None
    cands = []
    last_line = ''
    for line in lines:
        # if line.startswith(' .text'):
        #     tokens = line.split()
        #     # objfile = tokens[3]
        #     # curOverlay = True if 'overlays/' in objfile else False
        #     ram_base = int(tokens[1], 0)
        if 'load address' in line:
            tokens = last_line.split() + line.split()
            ram_base = int(tokens[1], 0)
            if tokens[0].startswith('..ovl_'):
                curOverlay = tokens[0][6:].lower()
            else:
                curOverlay = None
        if line.endswith(' ' + funcName + '\n'):
            ram = int(line.split()[0], 0)
            foundOverlay = curOverlay
            if foundOverlay:
                offset = ram - ram_base
                cands.append(offset)
            else:
                cands.append(ram)
        last_line = line
    
    if len(cands) == 1:
        if foundOverlay:
            return cur_actor_offset + cands[0], foundOverlay
        else:
            return cands[0], foundOverlay
    elif len(cands) > 1:
        fail(f'Found more than one function with name {funcName}')
    else:
        fail(f'Could not find function with name {funcName}')

    return 0x0

def setActor(actorName: str, addr: int):
    global cur_actor_name
    global cur_actor_offset
    
    cur_actor_name = actorName
    cur_actor_offset = addr

if __name__ == '__main__':
    main()