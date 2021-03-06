// maps to breakpoint(s)
// logical
var funcNameToBreakpoint = {};
var ovlNameToBreakpoints = {};
// physical
var idToBreakpoint = {};
var addrToBreakpoint = {};

// map to watchpoint
var ovlNameToWatchpoint = {};

function Breakpoint(funcName) {
    this.enabled = false;
    this.funcName = funcName;
    this.addr = null;
    this.id = null;

    funcNameToBreakpoint[funcName] = this;
}

Breakpoint.prototype.setOvl = function(name, offset) {    
    this.ovlName = name;
    this.ovlOffset = offset;

    if (name in ovlNameToBreakpoints) {
        ovlNameToBreakpoints[name].push(this);
    } else {
        ovlNameToBreakpoints[name] = [this];
    }
};

Breakpoint.prototype.enable = function(addr) {
    if (this.enabled) {
        return;
    }
    
    this.addr = addr;
    addrToBreakpoint[addr] = this;

    var funcName = this.funcName;

    this.id = events.onexec(addr, function() {
        alert('hit breakpoint ' + funcName);
        debug.breakhere();
    });
    idToBreakpoint[this.id] = this;

    this.enabled = true;
}

Breakpoint.prototype.disable = function() {
    if (this.enabled === false) {
        return;
    }

    events.remove(this.id);

    delete addrToBreakpoint[this.addr];
    this.addr = null;
    delete idToBreakpoint[this.id];
    this.id = null;

    this.enabled = false;
}

Breakpoint.prototype.delete = function() {
    this.disable();

    delete funcNameToBreakpoint[this.funcName];
    // overlay specific cleanup
    if (this.ovlName) {
        if (ovlNameToBreakpoints[this.ovlName].length == 1) {   // deleting last breakpoint for overlay
            delete ovlNameToBreakpoints[this.ovlName];
            events.remove(ovlNameToWatchpoint[this.ovlName]);
            delete ovlNameToWatchpoint[this.ovlName];
        } else {
            var index = ovlNameToBreakpoints[this.ovlName].indexOf(this);
            ovlNameToBreakpoints[this.ovlName].splice(index, 1);
        }
    }
}

// server info
var server = new Server({port: 7340});
var socket = null;

// overlay table locations
var actorOverlayTableLoc = 0;
var particleOverlayTableLoc = 0;
var gamestateOverlayTableLoc = 0;
var kaleidoOverlayTableLoc = 0;

// client-server messaging
var buf_size = 16777216;   // 4 MB
var receivedBytes = new DataView(new ArrayBuffer(buf_size));
var bytesReceived = 0;
var bytesExpected = -1;
var readHeader = false;


server.on('connection', function(newSocket) {
    if (socket !== null) {
        console.log('Error: only one client at a time may be connected to the server');
        return;
    }

    console.log('Client connected!');

    socket = newSocket;
    
    newSocket.on('data', function(data) {   // data is type Uint8Array
        header_len = 4

        for (var i = 0; i < data.byteLength; i++) {
            receivedBytes.setUint8(bytesReceived++, data[i]);
        }

        while (true) {
            if (!readHeader && bytesReceived >= header_len) {
                // header consists of Uint32 (little-endian) indicating character count of message content
                bytesExpected = header_len + receivedBytes.getUint32(0, true);
                readHeader = true;
            }
            
            if (readHeader && bytesReceived === bytesExpected) {
                var charCodes = new Uint8Array(receivedBytes.buffer, header_len, bytesExpected - header_len);

                var msgFromClient = String(String.fromCharCode.apply(null, charCodes));
                handleInput(newSocket, msgFromClient);
                
                receivedBytes = new DataView(new ArrayBuffer(buf_size));
                readHeader = false;
                bytesReceived -= bytesExpected;
                bytesExpected = -1;

                continue;
            } else if (readHeader && bytesReceived > bytesExpected) {
                console.log('Error: received invalid packet');
            }

            break;
        }
    });


    newSocket.on('close', function() {
        // remove all active breakpoints
        for (var funcName in funcNameToBreakpoint) {
            funcNameToBreakpoint[funcName].delete();
        }

        console.log('Client disconnected! Cleared all breakpoints');
        socket = null;
    });
});

console.log('The server is running');

// Returns message to send to client
function processCommand(command) {
    console.log(command);
    var split = command.split(' ');
    if (split[0] == 'break') {
        if (split[2] == 'ovl') {    // breakpoint in overlay
            var funcName = split[1];
            var ovlName = split[3];
            var ovlOffset = parseInt(split[4]);

            if (funcNameToBreakpoint[funcName]) {   // function already has a breakpoint
                return 'success';
            }

            if (setBreakpointInOvl(ovlName, ovlOffset, funcName, actorOverlays, actorOverlayTableLoc, 0x20, 0x10)) {
                return 'success';
            }

            if (setBreakpointInOvl(ovlName, ovlOffset, funcName, particleOverlays, particleOverlayTableLoc, 0x1C, 0x10)) {
                return 'success';
            }

            if (setBreakpointInOvl(ovlName, ovlOffset, funcName, gamestateOverlays, gamestateOverlayTableLoc, 0x30, 0)) {
                return 'success';
            }

            if (setBreakpointInOvl(ovlName, ovlOffset, funcName, kaleidoOverlays, kaleidoOverlayTableLoc, 0x30, 0)) {
                return 'success';
            }
            
            console.log('Error: tried to set breakpoint in unrecognized overlay: ' + ovlName);
            return 'server did not recognize overlay'
        } else {    // breakpoint not in overlay
            var funcName = split[1];
            var addr = parseInt(split[2]);

            if (funcNameToBreakpoint[funcName]) {   // function already has a breakpoint
                return funcName + ' already has an active breakpoint';
            }

            var newBreakPoint = new Breakpoint(funcName);
            newBreakPoint.enable(addr);
            return 'success';
        }
    } else if (split[0] == 'info') {
        var funcNameArr = [];
        for (var funcName in funcNameToBreakpoint) {
            funcNameArr.push(funcName);
        }
        if (funcNameArr.length > 0) {
            funcNameArr.sort();
            return funcNameArr.join('\n');
        } else {
            return '(no active breakpoints)';
        }
    } else if (split[0] == 'delete') {
        var funcName = split[1];
        if (!funcNameToBreakpoint[funcName]) {  // function does not have a breakpoint
            return funcName + ' does not have an active breakpoint';
        }

        funcNameToBreakpoint[funcName].delete();
        return 'success';
    } else if (split[0] == 'clear') {
        // remove all active breakpoints
        for (var funcName in funcNameToBreakpoint) {
            funcNameToBreakpoint[funcName].delete();
        }
        return 'success';
    } else if (split[0] == 'tablelocs') {
        // client is reporting addresses of overlay tables
        actorOverlayTableLoc = parseInt(split[1]);
        particleOverlayTableLoc = parseInt(split[2]);
        gamestateOverlayTableLoc = parseInt(split[3]);
        kaleidoOverlayTableLoc = parseInt(split[4]);

        return 'success';
    } 
    else {
        console.log('Error: unrecognized command from client: ' + command);
    }

    return 'server did not recognize command';
}

function handleInput(sock, inputText) {
    var json_obj = getValidJSON(inputText);
    if (json_obj) {
        console.log('received valid JSON');
    } else {
        var msg = processCommand(inputText);
        console.log('msg for client: ' + msg);
        if (msg) {
            sendToClient(sock, msg);
        }
    }
}

function sendToClient(sock, msg) {
    var lengthStr = msg.length.toString(16);
    while (lengthStr.length < 8) {
        lengthStr = '0' + lengthStr;
    }

    msg = '0x' + lengthStr + msg;

    sock.write(msg);
}

// Returns JSON obj iff text is valid JSON. Otherwise, returns null
function getValidJSON(text) {
    try {
        var obj = JSON.parse(text);
        return obj;
    } catch (e) {
        return null;
    }
}

// Sets a breakpoint for funcName at offset ovlOffset in overlay ovlName. Returns true on success, false on failure
function setBreakpointInOvl(ovlName, ovlOffset, funcName, overlayTable, tableBase, tableEntrySize, tableEntryOffset) {
    var ovlId = overlayTable.indexOf(ovlName);
    if (ovlId >= 0) {
        var tableEntry = tableBase + ovlId * tableEntrySize;
        var ovlFileBase = mem.u32[tableEntry + tableEntryOffset];
        if (ovlFileBase == 0) {
            var newBreakpoint = new Breakpoint(funcName);
            newBreakpoint.setOvl(ovlName, ovlOffset);
        } else {
            var ovlFileBreakAddr = ovlFileBase + ovlOffset;
            var newBreakpoint = new Breakpoint(funcName);
            newBreakpoint.setOvl(ovlName, ovlOffset);
            newBreakpoint.enable(ovlFileBreakAddr);
        }

        if (ovlName in ovlNameToWatchpoint) {   // already watching overlay for address change
            // do nothing
        } else {
            var watchpointId = events.onwrite(tableEntry + tableEntryOffset, function(addr) {
                // set breakpoint on any address, have this breakpoint read in the new overlay file location and then delete itself
                var tempBreakpointId = events.onexec(ADDR_ANY, function() {
                    var newOvlFileBase = mem.u32[addr];
                    if (newOvlFileBase != 0) {  // overlay file moved to new RAM address
                        // enable all breakpoints at new address
                        ovlNameToBreakpoints[ovlName].forEach(function(breakpoint) {
                            breakpoint.enable(newOvlFileBase + breakpoint.ovlOffset);
                        });
                    } else {    // overlay file deloaded from RAM
                        // disable all breakpoints for actor
                        ovlNameToBreakpoints[ovlName].forEach(function(breakpoint) {
                            breakpoint.disable();
                        });
                    }

                    events.remove(tempBreakpointId);
                });
            });

            ovlNameToWatchpoint[ovlName] = watchpointId;
        }

        return true;
    }

    return false;
}

const actorOverlays = ['player', 'unset_1', 'en_test', 'unset_3', 'en_girla', 'unset_5', 'unset_6', 'en_part', 'en_light', 'en_door', 'en_box', 'bg_dy_yoseizo', 'bg_hidan_firewall', 'en_poh', 'en_okuta', 'bg_ydan_sp', 'en_bom', 'en_wallmas', 'en_dodongo', 'en_firefly', 'en_horse', 'en_item00', 'en_arrow', 'unset_17', 'en_elf', 'en_niw', 'unset_1a', 'en_tite', 'en_reeba', 'en_peehat', 'en_butte', 'unset_1f', 'en_insect', 'en_fish', 'unset_22', 'en_holl', 'en_scene_change', 'en_zf', 'en_hata', 'boss_dodongo', 'boss_goma', 'en_zl1', 'en_viewer', 'en_goma', 'bg_pushbox', 'en_bubble', 'door_shutter', 'en_dodojr', 'en_bdfire', 'unset_31', 'en_boom', 'en_torch2', 'en_bili', 'en_tp', 'unset_36', 'en_st', 'en_bw', 'en_a_obj', 'en_eiyer', 'en_river_sound', 'en_horse_normal', 'en_ossan', 'bg_treemouth', 'bg_dodoago', 'bg_hidan_dalm', 'bg_hidan_hrock', 'en_horse_ganon', 'bg_hidan_rock', 'bg_hidan_rsekizou', 'bg_hidan_sekizou', 'bg_hidan_sima', 'bg_hidan_syoku', 'en_xc', 'bg_hidan_curtain', 'bg_spot00_hanebasi', 'en_mb', 'en_bombf', 'en_zl2', 'bg_hidan_fslift', 'en_oe2', 'bg_ydan_hasi', 'bg_ydan_maruta', 'boss_ganondrof', 'unset_53', 'en_am', 'en_dekubaba', 'en_m_fire1', 'en_m_thunder', 'bg_ddan_jd', 'bg_breakwall', 'en_jj', 'en_horse_zelda', 'bg_ddan_kd', 'door_warp1', 'obj_syokudai', 'item_b_heart', 'en_dekunuts', 'bg_menkuri_kaiten', 'bg_menkuri_eye', 'en_vali', 'bg_mizu_movebg', 'bg_mizu_water', 'arms_hook', 'en_fhg', 'bg_mori_hineri', 'en_bb', 'bg_toki_hikari', 'en_yukabyun', 'bg_toki_swd', 'en_fhg_fire', 'bg_mjin', 'bg_hidan_kousi', 'door_toki', 'bg_hidan_hamstep', 'en_bird', 'unset_73', 'unset_74', 'unset_75', 'unset_76', 'en_wood02', 'unset_78', 'unset_79', 'unset_7a', 'unset_7b', 'en_lightbox', 'en_pu_box', 'unset_7e', 'unset_7f', 'en_trap', 'en_arow_trap', 'en_vase', 'unset_83', 'en_ta', 'en_tk', 'bg_mori_bigst', 'bg_mori_elevator', 'bg_mori_kaitenkabe', 'bg_mori_rakkatenjo', 'en_vm', 'demo_effect', 'demo_kankyo', 'bg_hidan_fwbig', 'en_floormas', 'en_heishi1', 'en_rd', 'en_po_sisters', 'bg_heavy_block', 'bg_po_event', 'obj_mure', 'en_sw', 'boss_fd', 'object_kankyo', 'en_du', 'en_fd', 'en_horse_link_child', 'door_ana', 'bg_spot02_objects', 'bg_haka', 'magic_wind', 'magic_fire', 'unset_a0', 'en_ru1', 'boss_fd2', 'en_fd_fire', 'en_dh', 'en_dha', 'en_rl', 'en_encount1', 'demo_du', 'demo_im', 'demo_tre_lgt', 'en_fw', 'bg_vb_sima', 'en_vb_ball', 'bg_haka_megane', 'bg_haka_meganebg', 'bg_haka_ship', 'bg_haka_sgami', 'unset_b2', 'en_heishi2', 'en_encount2', 'en_fire_rock', 'en_brob', 'mir_ray', 'bg_spot09_obj', 'bg_spot18_obj', 'boss_va', 'bg_haka_tubo', 'bg_haka_trap', 'bg_haka_huta', 'bg_haka_zou', 'bg_spot17_funen', 'en_syateki_itm', 'en_syateki_man', 'en_tana', 'en_nb', 'boss_mo', 'en_sb', 'en_bigokuta', 'en_karebaba', 'bg_bdan_objects', 'demo_sa', 'demo_go', 'en_in', 'en_tr', 'bg_spot16_bombstone', 'unset_ce', 'bg_hidan_kowarerukabe', 'bg_bombwall', 'bg_spot08_iceblock', 'en_ru2', 'obj_dekujr', 'bg_mizu_uzu', 'bg_spot06_objects', 'bg_ice_objects', 'bg_haka_water', 'unset_d8', 'en_ma2', 'en_bom_chu', 'en_horse_game_check', 'boss_tw', 'en_rr', 'en_ba', 'en_bx', 'en_anubice', 'en_anubice_fire', 'bg_mori_hashigo', 'bg_mori_hashira4', 'bg_mori_idomizu', 'bg_spot16_doughnut', 'bg_bdan_switch', 'en_ma1', 'boss_ganon', 'boss_sst', 'unset_ea', 'unset_eb', 'en_ny', 'en_fr', 'item_shield', 'bg_ice_shelter', 'en_ice_hono', 'item_ocarina', 'unset_f2', 'unset_f3', 'magic_dark', 'demo_6k', 'en_anubice_tag', 'bg_haka_gate', 'bg_spot15_saku', 'bg_jya_goroiwa', 'bg_jya_zurerukabe', 'unset_fb', 'bg_jya_cobra', 'bg_jya_kanaami', 'fishing', 'obj_oshihiki', 'bg_gate_shutter', 'eff_dust', 'bg_spot01_fusya', 'bg_spot01_idohashira', 'bg_spot01_idomizu', 'bg_po_syokudai', 'bg_ganon_otyuka', 'bg_spot15_rrbox', 'bg_umajump', 'unset_109', 'arrow_fire', 'arrow_ice', 'arrow_light', 'unset_10d', 'unset_10e', 'item_etcetera', 'obj_kibako', 'obj_tsubo', 'en_wonder_item', 'en_ik', 'demo_ik', 'en_skj', 'en_skjneedle', 'en_g_switch', 'demo_ext', 'demo_shd', 'en_dns', 'elf_msg', 'en_honotrap', 'en_tubo_trap', 'obj_ice_poly', 'bg_spot03_taki', 'bg_spot07_taki', 'en_fz', 'en_po_relay', 'bg_relay_objects', 'en_diving_game', 'en_kusa', 'obj_bean', 'obj_bombiwa', 'unset_128', 'unset_129', 'obj_switch', 'obj_elevator', 'obj_lift', 'obj_hsblock', 'en_okarina_tag', 'en_yabusame_mark', 'en_goroiwa', 'en_ex_ruppy', 'en_toryo', 'en_daiku', 'unset_134', 'en_nwc', 'en_blkobj', 'item_inbox', 'en_ge1', 'obj_blockstop', 'en_sda', 'en_clear_tag', 'en_niw_lady', 'en_gm', 'en_ms', 'en_hs', 'bg_ingate', 'en_kanban', 'en_heishi3', 'en_syateki_niw', 'en_attack_niw', 'bg_spot01_idosoko', 'en_sa', 'en_wonder_talk', 'bg_gjyo_bridge', 'en_ds', 'en_mk', 'en_bom_bowl_man', 'en_bom_bowl_pit', 'en_owl', 'en_ishi', 'obj_hana', 'obj_lightswitch', 'obj_mure2', 'en_go', 'en_fu', 'unset_154', 'en_changer', 'bg_jya_megami', 'bg_jya_lift', 'bg_jya_bigmirror', 'bg_jya_bombchuiwa', 'bg_jya_amishutter', 'bg_jya_bombiwa', 'bg_spot18_basket', 'unset_15d', 'en_ganon_organ', 'en_siofuki', 'en_stream', 'unset_161', 'en_mm', 'en_ko', 'en_kz', 'en_weather_tag', 'bg_sst_floor', 'en_ani', 'en_ex_item', 'bg_jya_ironobj', 'en_js', 'en_jsjutan', 'en_cs', 'en_md', 'en_hy', 'en_ganon_mant', 'en_okarina_effect', 'en_mag', 'door_gerudo', 'elf_msg2', 'demo_gt', 'en_po_field', 'efc_erupc', 'bg_zg', 'en_heishi4', 'en_zl3', 'boss_ganon2', 'en_kakasi', 'en_takara_man', 'obj_makeoshihiki', 'oceff_spot', 'end_title', 'unset_180', 'en_torch', 'demo_ec', 'shot_sun', 'en_dy_extra', 'en_wonder_talk2', 'en_ge2', 'obj_roomtimer', 'en_ssh', 'en_sth', 'oceff_wipe', 'oceff_storm', 'en_weiyer', 'bg_spot05_soko', 'bg_jya_1flift', 'bg_jya_haheniron', 'bg_spot12_gate', 'bg_spot12_saku', 'en_hintnuts', 'en_nutsball', 'bg_spot00_break', 'en_shopnuts', 'en_it', 'en_geldb', 'oceff_wipe2', 'oceff_wipe3', 'en_niw_girl', 'en_dog', 'en_si', 'bg_spot01_objects2', 'obj_comb', 'bg_spot11_bakudankabe', 'obj_kibako2', 'en_dnt_demo', 'en_dnt_jiji', 'en_dnt_nomal', 'en_guest', 'bg_bom_guard', 'en_hs2', 'demo_kekkai', 'bg_spot08_bakudankabe', 'bg_spot17_bakudankabe', 'unset_1aa', 'obj_mure3', 'en_tg', 'en_mu', 'en_go2', 'en_wf', 'en_skb', 'demo_gj', 'demo_geff', 'bg_gnd_firemeiro', 'bg_gnd_darkmeiro', 'bg_gnd_soulmeiro', 'bg_gnd_nisekabe', 'bg_gnd_iceblock', 'en_gb', 'en_gs', 'bg_mizu_bwall', 'bg_mizu_shutter', 'en_daiku_kakariko', 'bg_bowl_wall', 'en_wall_tubo', 'en_po_desert', 'en_crow', 'door_killer', 'bg_spot11_oasis', 'bg_spot18_futa', 'bg_spot18_shutter', 'en_ma3', 'en_cow', 'bg_ice_turara', 'bg_ice_shutter', 'en_kakasi2', 'en_kakasi3', 'oceff_wipe4', 'en_eg', 'bg_menkuri_nisekabe', 'en_zo', 'obj_makekinsuta', 'en_ge3', 'obj_timeblock', 'obj_hamishi', 'en_zl4', 'en_mm2', 'bg_jya_block', 'obj_warp2block', 'id_max'];

const particleOverlays = ['effect_ss_dust', 'effect_ss_kirakira', 'effect_ss_bomb', 'effect_ss_bomb2', 'effect_ss_blast', 'effect_ss_g_spk', 'effect_ss_d_fire', 'effect_ss_bubble', 'effect_ss_unset', 'effect_ss_g_ripple', 'effect_ss_g_splash', 'effect_ss_g_magma', 'effect_ss_g_fire', 'effect_ss_lightning', 'effect_ss_dt_bubble', 'effect_ss_hahen', 'effect_ss_stick', 'effect_ss_sibuki', 'effect_ss_sibuki2', 'effect_ss_g_magma2', 'effect_ss_stone1', 'effect_ss_hitmark', 'effect_ss_fhg_flash', 'effect_ss_k_fire', 'effect_ss_solder_srch_ball', 'effect_ss_kakera', 'effect_ss_ice_piece', 'effect_ss_en_ice', 'effect_ss_fire_tail', 'effect_ss_extra', 'effect_ss_fcircle', 'effect_ss_dead_db', 'effect_ss_dead_dd', 'effect_ss_dead_ds', 'effect_ss_dead_sound', 'effect_ss_ice_smoke', 'effect_ss_type_max'];

const gamestateOverlays = ['unset_0', 'select', 'title', 'unset_3', 'opening', 'file_choose'];

const kaleidoOverlays = ['kaleido_scope', 'player_actor'];
