// Konstanten Definitionen
const CONFIG = {
    INSTANCES: {
        E3DC_RSCP: 'e3dc-rscp.0',
        HEIZSTAB_MODBUS: 'modbus.1'
    },
    HEIZSTAB: {
        DEBOUNCE_INTERVAL: 1000,
        TEMPERATURE_BUFFER: 3,
        MIN_POWER: 300,
        SAFETY_BUFFER: 500,
        MAX_POWER: 3000,
        MIN_TEMP: 0,
        MAX_TEMP: 100
    }
};

// E3DC Komponenten Definition 
const E3DC_STATES = {
    PV_POWER: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.POWER_PV`,
    GRID_POWER: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.POWER_GRID`,
    WALLBOX_POWER: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.POWER_WB_ALL`,
    BATTERY_POWER: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.POWER_BAT`,
    POWER_MODE: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.MODE`,
    BATTERY_STATUS: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.BAT_SOC`,
    BATTERY_CHARGE_LIMIT: `${CONFIG.INSTANCES.E3DC_RSCP}.EMS.SYS_SPECS.maxBatChargePower`
};

// Heizstab Modbus Variablen 
const HEIZSTAB_STATES = {
    CURRENT_POWER: `${CONFIG.INSTANCES.HEIZSTAB_MODBUS}.holdingRegisters.1000_Power`,
    TARGET_POWER: `${CONFIG.INSTANCES.HEIZSTAB_MODBUS}.holdingRegisters.1000_Power`,
    CURRENT_TEMP: `${CONFIG.INSTANCES.HEIZSTAB_MODBUS}.holdingRegisters.1001_Temp1`,
    MAX_TEMP: `${CONFIG.INSTANCES.HEIZSTAB_MODBUS}.holdingRegisters.1002_WW1_Temp_max`
};

// Statistik States
const STATISTICS_STATES = {
    PREVIOUS_POWER: '0_userdata.0.Heizung.E3DC.previousHeizstabLeistung',
    TOTAL_ENERGY: '0_userdata.0.Heizung.E3DC.Heizstab_Gesamtenergie',
    LAST_UPDATE: '0_userdata.0.Heizung.E3DC.Heizstab_LetzteAktualisierung'
};

// Hilfsfunktionen
function validateTemperature(temp) {
    if (temp < CONFIG.HEIZSTAB.MIN_TEMP || temp > CONFIG.HEIZSTAB.MAX_TEMP) {
        throw new Error(`Ungültige Temperatur: ${temp}°C`);
    }
    return temp;
}

function validatePower(power, allowNegative = false) {
    if (!allowNegative && power < 0) {
        throw new Error(`Ungültige Leistung: ${power}W`);
    }
    return power;
}

async function calculateAvailablePower(states) {
    const {
        PV_Leistung_W,
        Hausverbrauch_W,
        M_Power_W,
        Wallbox_Leistung_W
    } = states;

    let availablePower = PV_Leistung_W - Hausverbrauch_W - M_Power_W - Wallbox_Leistung_W - CONFIG.HEIZSTAB.SAFETY_BUFFER;
    if (M_Power_W !== 0) {
        availablePower -= CONFIG.HEIZSTAB.SAFETY_BUFFER;
    }
    return Math.max(availablePower, 0);
}

async function updateEnergyStatistics(currentPower, lastUpdate) {
    const jetzt = Date.now();
    const vergangeneZeitInStunden = (jetzt - (lastUpdate || 0)) / (1000 * 60 * 60);
    const verbrauchteEnergie = (currentPower * vergangeneZeitInStunden) / 1000;
    const aktuelleGesamtenergie = (await getStateAsync(STATISTICS_STATES.TOTAL_ENERGY)).val || 0;
    const neueGesamtenergie = aktuelleGesamtenergie + verbrauchteEnergie;

    await Promise.all([
        setStateAsync(STATISTICS_STATES.TOTAL_ENERGY, neueGesamtenergie),
        setStateAsync(STATISTICS_STATES.LAST_UPDATE, jetzt)
    ]);

    return neueGesamtenergie;
}

let debounceTimer;

async function fetchAndUpdateHeizstabLeistung() {
    try {
        // Zustände abfragen
        const states = await Promise.all([
            getStateAsync(E3DC_STATES.WALLBOX_POWER),
            getStateAsync(E3DC_STATES.GRID_POWER),
            getStateAsync(HEIZSTAB_STATES.CURRENT_POWER),
            getStateAsync('0_userdata.0.Charge_Control.Allgemein.Hausverbrauch'),
            getStateAsync('0_userdata.0.Charge_Control.Allgemein.Akt_Berechnete_Ladeleistung_W'),
            getStateAsync(E3DC_STATES.BATTERY_POWER),
            getStateAsync(HEIZSTAB_STATES.CURRENT_TEMP),
            getStateAsync(HEIZSTAB_STATES.MAX_TEMP),
            getStateAsync(E3DC_STATES.PV_POWER),
            getStateAsync(HEIZSTAB_STATES.TARGET_POWER),
            getStateAsync(E3DC_STATES.POWER_MODE),
            getStateAsync(E3DC_STATES.BATTERY_STATUS),
            getStateAsync(E3DC_STATES.BATTERY_CHARGE_LIMIT)
        ]);

        // Validierung der Zustände
        const stateNames = Object.keys(E3DC_STATES).concat(Object.keys(HEIZSTAB_STATES));
        const invalidStates = states.map((state, index) => 
            state === null || state === undefined ? stateNames[index] : null
        ).filter(Boolean);

        if (invalidStates.length > 0) {
            throw new Error(`Ungültige Zustände: ${invalidStates.join(', ')}`);
        }

        // Werte extrahieren und validieren
        const stateValues = {
            Wallbox_Leistung_W: validatePower(states[0].val),
            NetzLeistung_W: validatePower(states[1].val, true),
            LeistungHeizstab_W: validatePower(states[2].val),
            Hausverbrauch_W: validatePower(states[3].val),
            M_Power_W: validatePower(states[4].val),
            BatterieLeistung_W: validatePower(states[5].val, true),
            IstTemp: validateTemperature(states[6].val),
            MaxTemp: validateTemperature(states[7].val),
            PV_Leistung_W: validatePower(states[8].val),
            SollLeistungHeizstab_W: validatePower(states[9].val),
            PowerMode: states[10].val,
            BatterieStatus: states[11].val,
            Charge_Limit: states[12].val
        };

        // Bedingungen prüfen
        if (stateValues.PowerMode === 2 && 
            stateValues.Charge_Limit === stateValues.M_Power_W && 
            stateValues.BatterieLeistung_W > 0) {
            console.log('Power_Mode ist 2 und Batterie soll mit max. Leistung geladen werden. Heizstab wird nicht aktiviert.');
            await setStateAsync(HEIZSTAB_STATES.TARGET_POWER, 0);
            return;
        }

        // Verfügbaren Überschuss berechnen
        const verfuegbarerUeberschuss_W = await calculateAvailablePower(stateValues);

        // Heizstab-Leistung bestimmen
        let HeizstabLadeleistung_W = 0;
        if (stateValues.IstTemp < stateValues.MaxTemp - CONFIG.HEIZSTAB.TEMPERATURE_BUFFER && 
            verfuegbarerUeberschuss_W >= CONFIG.HEIZSTAB.MIN_POWER) {
            HeizstabLadeleistung_W = Math.min(verfuegbarerUeberschuss_W, CONFIG.HEIZSTAB.MAX_POWER);
        }

        // Zustände aktualisieren
        await Promise.all([
            setStateAsync(HEIZSTAB_STATES.TARGET_POWER, HeizstabLadeleistung_W),
            setStateAsync(STATISTICS_STATES.PREVIOUS_POWER, HeizstabLadeleistung_W)
        ]);

        // Energie-Statistiken aktualisieren
        const letzteAktualisierung = (await getStateAsync(STATISTICS_STATES.LAST_UPDATE)).val;
        await updateEnergyStatistics(stateValues.LeistungHeizstab_W, letzteAktualisierung);

        console.log(`Update: Netz=${stateValues.NetzLeistung_W}W, PV=${stateValues.PV_Leistung_W}W, Wallbox=${stateValues.Wallbox_Leistung_W}W, Heizstab=${HeizstabLadeleistung_W}W, Überschuss=${verfuegbarerUeberschuss_W}W`);
    } catch (error) {
        console.error('Fehler bei der Aktualisierung der Heizstab-Leistung:', error.message);
        console.error(error.stack);
    }
}

function debounceUpdate() {
    if (debounceTimer) return;
    fetchAndUpdateHeizstabLeistung();
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
    }, CONFIG.HEIZSTAB.DEBOUNCE_INTERVAL);
}

// Listener registrieren
const stateIds = [
    E3DC_STATES.WALLBOX_POWER,
    E3DC_STATES.PV_POWER,
    E3DC_STATES.GRID_POWER,
    '0_userdata.0.Charge_Control.Allgemein.Hausverbrauch',
    E3DC_STATES.BATTERY_POWER,
    HEIZSTAB_STATES.CURRENT_POWER,
    '0_userdata.0.Charge_Control.Allgemein.Akt_Berechnete_Ladeleistung_W',
    E3DC_STATES.POWER_MODE,
    E3DC_STATES.BATTERY_STATUS
];

stateIds.forEach(id => {
    on({ id, change: "ne" }, debounceUpdate);
    console.log(`Listener registriert für ${id}`);
});

// Initialer Aufruf
fetchAndUpdateHeizstabLeistung();
