const Papa = require('papaparse');
const fs = require('fs');
const path = require('path');

// Read the CSV file directly
const csvData = fs.readFileSync(path.join(__dirname, 'jeopardy.csv'), 'utf-8');
const all = Papa.parse(csvData, { header: true }).data;

// Fix up the data format
all.forEach((row, i) => {
  if (!row.coord) {
    return;
  }
  const slice = row.coord.slice(1, row.coord.length - 1);
  all[i].xcoord = Number(slice.split(',')[0]);
  all[i].ycoord = Number(slice.split(',')[1]);
  all[i].daily_double = all[i].daily_double === 'True';
  all[i].round_name = all[i].round_name.split(' ')[0].toLowerCase();

  if (all[i].round_name === 'final') {
    all[i].value = 0;
  } else if (all[i].round_name === 'double') {
    all[i].value = all[i].ycoord * 400;
  } else {
    all[i].value = all[i].ycoord * 200;
  }
});

// Store a set of episode IDs, map to episode info
let output = {};
all.forEach((row) => {
  if (!row.epNum) {
    return;
  }
  if (!output[row.epNum]) {
    let info = undefined;
    if (/^\d{4} Teen Tournament/.test(row.extra_info)) {
      info = 'teen';
    } else if (/^\d{4} College Championship/.test(row.extra_info)) {
      info = 'college';
    } else if (/^\d{4} Kids Week/.test(row.extra_info)) {
      info = 'kids';
    } else if (/^\d{4} Celebrity/.test(row.extra_info)) {
      info = 'celebrity';
    } else if (/^\d{4} Teacher/.test(row.extra_info)) {
      info = 'teacher';
    } else if (/^\d{4} Tournament of Champions/.test(row.extra_info)) {
      info = 'champions';
    }
    output[row.epNum] = {
      epNum: row.epNum,
      airDate: row.airDate,
      info,
      jeopardy: [],
      double: [],
      final: [],
    };
  }
  
  if (!output[row.epNum][row.round_name]) {
    return;
  }

  output[row.epNum][row.round_name].push({
    x: row.xcoord,
    y: row.ycoord,
    q: row.question,
    a: row.answer.replace(/\\/g, ''),
    cat: row.category,
    dd: row.daily_double,
    val: row.value,
  });
});

fs.writeFileSync(path.join(__dirname, 'jeopardy.json'), JSON.stringify(output));
console.log('Episodes: %d, Clues: %d', Object.keys(output).length, all.length);